import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type {
  AgentMemory,
  AgentNotification,
  RevisionEntry,
} from "../../../packages/domain/src/agent.ts";
import type { ActionLogEntry } from "../../../packages/domain/src/index.ts";
import type {
  ConversationEvent,
  ResourceLease,
  ResourceRequest,
  RuntimePauseState,
  WorkClass,
} from "../../../packages/domain/src/runtime.ts";
import { initializeDurableConversations } from "./durable-schema.ts";
import { initializeTaskRuntime } from "./engine/task-schema.ts";
import { AppError } from "./errors.ts";
import { initializeHistoryRetrieval, type ThreadWindow } from "./history-retrieval.ts";
import { backgroundFailure } from "./log.ts";
import { memoryFingerprintFields } from "./memory-fingerprint.ts";
import { initializeThreadCompaction, type ThreadMessagePage } from "./thread-compaction.ts";
import { initializeThreadLifecycle } from "./thread-lifecycle.ts";

type Row = { data: Record<string, unknown> };
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  close: () => Promise<void>;
}

export class Store {
  async chatSocialRecords<T>(
    owner: string,
    threadId: string,
    kind: "message-reactions" | "conversation-inbox",
    messageIds: string[],
  ) {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>'threadId'=$3 AND data->>'messageId'=ANY($4::text[])",
      [owner, kind, threadId, messageIds],
    );
    return result.rows.map((row) => row.data as T);
  }
  async chatSource<T>(
    owner: string,
    source: { messageId: string; threadId: string; runId: string },
  ): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind='conversation-inbox' AND data->>'messageId'=$2 AND data->>'threadId'=$3 AND data->>'runId'=$4 LIMIT 1",
      [owner, source.messageId, source.threadId, source.runId],
    );
    return (result.rows[0]?.data as T) ?? null;
  }
  async nextProactivityWakeAt(owner: string): Promise<string | null> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('at',min((data->>'readyAt')::timestamptz)) AS data FROM records WHERE owner=$1 AND kind='proactivity-events' AND data->>'status'='pending'",
      [owner],
    );
    const at = result.rows[0]?.data.at as string | null;
    return at ? new Date(at).toISOString() : null;
  }
  async dueProactivityEvents<T>(
    owner: string,
    now: string,
    includeCoalescing: boolean,
  ): Promise<T[]> {
    const result = await this.db.query(
      `SELECT data FROM records WHERE owner=$1 AND kind='proactivity-events'
      AND data->>'status'='pending' AND (data->>'dueAt')::timestamptz<=$2::timestamptz AND ($3::boolean OR (data->>'readyAt')::timestamptz<=$2::timestamptz)
      AND (data->>'expiresAt' IS NULL OR (data->>'expiresAt')::timestamptz>$2::timestamptz)
      ORDER BY CASE data->>'intent' WHEN 'immediate' THEN 0 WHEN 'event' THEN 1 ELSE 2 END,(data->>'readyAt')::timestamptz,id LIMIT 50`,
      [owner, now, includeCoalescing],
    );
    return result.rows.map((row) => row.data as T);
  }
  async retireInvalidProactivityEvents(owner: string, now: string) {
    await this.write(
      `UPDATE records event SET data=data || '{"status":"settled","reason":"Source expired or changed"}'::jsonb,updated_at=now()
      WHERE owner=$1 AND kind='proactivity-events' AND data->>'status'='pending' AND (
        (data->>'expiresAt')::timestamptz<=$2::timestamptz OR (data->>'source'='memory' AND NOT EXISTS(SELECT 1 FROM records memory
          WHERE memory.owner=$1 AND memory.kind='memories' AND memory.id=event.data->>'key' AND memory.data->>'status'='active'
          AND memory.data->>'category'='plan' AND memory.data->'followUp'->>'state'='open' AND COALESCE(memory.data->>'revision','0')=event.data->>'revision'
          AND (memory.data->>'validUntil' IS NULL OR (memory.data->>'validUntil')::timestamptz>$2::timestamptz)))
        OR (data->>'source'='deadline' AND NOT EXISTS(SELECT 1 FROM records task WHERE task.owner=$1 AND task.kind='tasks'
          AND task.id=event.data->>'key' AND task.data->>'status' NOT IN ('succeeded','failed','cancelled','paused')
          AND task.data->'timing'->>'dueAt' IS NOT NULL AND COALESCE(task.data->'state'->>'timingRevision','0')=event.data->>'revision'))
      )`,
      [owner, now],
    );
  }
  async proactivityDeadlineCandidates<T>(
    owner: string,
    before: string,
  ): Promise<{ source: "memory" | "deadline"; value: T }[]> {
    const result = await this.db.query(
      `SELECT jsonb_build_object('source',CASE WHEN source.kind='memories' THEN 'memory' ELSE 'deadline' END,'value',source.data) AS data
      FROM records source WHERE source.owner=$1 AND (
        (kind='memories' AND data->>'status'='active' AND data->>'category'='plan' AND data->'followUp'->>'state'='open' AND (data->'followUp'->>'after')::timestamptz<=$2::timestamptz AND (data->>'validUntil' IS NULL OR (data->>'validUntil')::timestamptz>$3::timestamptz))
        OR (kind='tasks' AND data->>'status' NOT IN ('succeeded','failed','cancelled','paused') AND (data->'timing'->>'dueAt')::timestamptz<=$2::timestamptz AND data->'input'->>'internalActivity' IS DISTINCT FROM 'true' AND NOT (data->'input' ? 'proactivityCycleId') AND (data->'timing'->>'validUntil' IS NULL OR (data->'timing'->>'validUntil')::timestamptz>$3::timestamptz)))
      AND NOT EXISTS(SELECT 1 FROM records event WHERE event.owner=$1 AND event.kind='proactivity-events'
        AND event.data->>'source'=CASE WHEN source.kind='memories' THEN 'memory' ELSE 'deadline' END
        AND event.data->>'key'=source.id AND event.data->>'revision'=CASE WHEN source.kind='memories' THEN COALESCE(source.data->>'revision','0') ELSE COALESCE(source.data->'state'->>'timingRevision','0') END)
      ORDER BY COALESCE(data->'followUp'->>'after',data->'timing'->>'dueAt')::timestamptz,id LIMIT 100`,
      [owner, before, new Date(Date.parse(before) - 4 * 3600000).toISOString()],
    );
    return result.rows.map(
      (row) => row.data as unknown as { source: "memory" | "deadline"; value: T },
    );
  }
  async procedureCatalog(
    owner: string,
    options: { query: string; cursor?: string; limit: number; includeArchived: boolean },
  ) {
    const result = await this.db.query(
      `WITH candidates AS (
      SELECT id,data->'versions'->-1 AS value FROM records WHERE owner=$1 AND kind='playbooks'
    ), ranked AS (SELECT *,row_number() OVER (ORDER BY id) AS position FROM candidates
      WHERE ($3::boolean OR COALESCE(value->>'lifecycle','active')<>'archived')
      AND ($2='' OR id=$2 OR openmuse_search_vector(value->>'title' || ' ' || (value->'steps')::text) @@ openmuse_search_query($2)))
    SELECT jsonb_build_object('id',id,'title',value->>'title','version',value->'version','learned',COALESCE(value->'learned','false'::jsonb),
      'pinned',COALESCE(value->'pinned','false'::jsonb),'lifecycle',COALESCE(value->>'lifecycle','active'),'requiredTools',value->'requiredTools','savedAt',value->>'savedAt') AS data
    FROM ranked WHERE ($4::text IS NULL OR position>COALESCE((SELECT position FROM ranked WHERE id=$4),0)) ORDER BY position LIMIT $5`,
      [owner, options.query, options.includeArchived, options.cursor ?? null, options.limit + 1],
    );
    const entries = result.rows
      .slice(0, options.limit)
      .map(
        (row) =>
          row.data as unknown as import("../../../packages/domain/src/playbooks.ts").ProcedureCatalogEntry,
      );
    return {
      entries,
      ...(result.rows.length > options.limit ? { nextCursor: entries.at(-1)?.id } : {}),
    };
  }
  async procedureUsage(owner: string, id: string, version?: number) {
    const result = await this.db.query(
      `WITH runs AS (SELECT data FROM records WHERE owner=$1 AND kind='playbook-runs' AND data->>'procedureId'=$2 AND ($3::text IS NULL OR data->>'procedureVersion'=$3)),
      outcomes AS (SELECT data FROM records WHERE owner=$1 AND kind='procedure-outcomes' AND data->>'procedureId'=$2 AND ($3::text IS NULL OR data->>'procedureVersion'=$3)),
      views AS (SELECT data FROM records WHERE owner=$1 AND kind='procedure-views' AND data->>'procedureId'=$2 AND ($3::text IS NULL OR data->>'procedureVersion'=$3))
      SELECT jsonb_build_object('runs',(SELECT count(*) FROM runs),'views',(SELECT count(*) FROM views),
       'verified',(SELECT count(*) FROM outcomes WHERE data->>'outcome'='verified'),'failed',(SELECT count(*) FROM outcomes WHERE data->>'outcome'='failed'),
       'partial',(SELECT count(*) FROM outcomes WHERE data->>'outcome'='partial'),'cancelled',(SELECT count(*) FROM outcomes WHERE data->>'outcome'='cancelled'),
       'lastUsedAt',(SELECT max(at) FROM (SELECT data->>'createdAt' AS at FROM runs UNION ALL SELECT data->>'finishedAt' FROM outcomes) activity),
       'lastViewedAt',(SELECT max(data->>'viewedAt') FROM views)) AS data`,
      [owner, id, version === undefined ? null : String(version)],
    );
    return result.rows[0].data as unknown as {
      runs: number;
      views: number;
      verified: number;
      failed: number;
      partial: number;
      cancelled: number;
      lastUsedAt: string | null;
      lastViewedAt: string | null;
    };
  }
  async procedureRunForTask<T>(owner: string, taskId: string): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind='playbook-runs' AND data->>'taskId'=$2 LIMIT 1",
      [owner, taskId],
    );
    return (result.rows[0]?.data as T) ?? null;
  }
  async procedureInUse(owner: string, id: string, title: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM records WHERE owner=$1 AND (
      (kind='tasks' AND data->'input'->'procedure'->>'id'=$2 AND data->>'status' NOT IN ('succeeded','failed','cancelled'))
      OR (kind='routines' AND data->>'deleted' IS DISTINCT FROM 'true' AND data->>'enabled'='true' AND (strpos(data->>'prompt',$2)>0 OR strpos(lower(data->>'prompt'),lower($3))>0))) LIMIT 1`,
      [owner, id, title],
    );
    return result.rows.length > 0;
  }
  async proactivityBindings<T>(owner: string, taskId: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind='proactivity-suggestions' AND data->>'taskId'=$2 AND data->>'status'='accepted' ORDER BY id LIMIT 100",
      [owner, taskId],
    );
    return result.rows.map((row) => row.data as T);
  }
  /** Two matching roots are enough to diagnose ambiguity without scanning every owner's task. */
  async goalTaskCandidates<T>(owner: string, goalId: string, milestoneId?: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind='tasks' AND data->>'goalId'=$2 AND data->>'milestoneId' IS NOT DISTINCT FROM $3::text AND data->'state'->>'parentTaskId' IS NULL ORDER BY id LIMIT 2",
      [owner, goalId, milestoneId ?? null],
    );
    return result.rows.map((row) => row.data as T);
  }
  async pendingProactivityContinuations<T>() {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind='proactivity-suggestions' AND data->>'status'='accepted' AND data->'continuation' IS NOT NULL AND data->'continuation'->>'delivered' IS DISTINCT FROM 'true' ORDER BY id LIMIT 100",
    );
    return result.rows.map((row) => row.data as unknown as { owner: string; value: T });
  }
  async applyTaskMailbox<T>(owner: string, taskId: string, runToken: string): Promise<T | null> {
    const result = await this.write("SELECT openmuse_apply_task_mailbox($1,$2,$3) AS data", [
      owner,
      taskId,
      runToken,
    ]);
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async authorizeTaskOperation<T>(
    owner: string,
    operationId: string,
    revision: number,
    runToken: string,
    handles: ResourceLease[],
    validateOnly = false,
  ) {
    const result = await this.write(
      "SELECT openmuse_authorize_task_operation($1,$2,$3::bigint,$4,$5::jsonb,$6::boolean) AS data",
      [owner, operationId, revision, runToken, JSON.stringify(handles), validateOnly],
    );
    return result.rows[0].data as unknown as { code: string; operation?: T };
  }
  async guardTaskAction(owner: string, id: string, validateOnly = false) {
    const result = await this.write("SELECT openmuse_guard_task_action($1,$2,$3) AS data", [
      owner,
      id,
      validateOnly,
    ]);
    return result.rows[0].data as unknown as string;
  }
  async consumeTaskBudget<T>(owner: string, rootId: string, elapsedMs: number): Promise<T | null> {
    const result = await this.write(
      "SELECT openmuse_consume_task_budget($1,$2,$3::bigint) AS data",
      [owner, rootId, Math.max(0, Math.floor(elapsedMs))],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async chargeTaskBudget<T>(owner: string, rootId: string, elapsedMs: number): Promise<T | null> {
    const result = await this.write(
      "SELECT openmuse_charge_task_budget($1,$2,$3::bigint) AS data",
      [owner, rootId, Math.max(0, Math.floor(elapsedMs))],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /** A run row is the dispatch boundary: no row permits retry, any row forbids uncertain repetition. */
  async recordInboxFailure(owner: string, messageId: string, runToken: string): Promise<boolean> {
    const result = await this.write("SELECT openmuse_inbox_failure($1,$2,$3) AS data", [
      owner,
      messageId,
      runToken,
    ]);
    return (result.rows[0]?.data as unknown) === true;
  }
  /** Inbox dispatch and the chat lease are claimed in one statement across runner instances. */
  async claimInboxMessage(
    owner: string,
    id: string,
    threadId: string,
    token: string,
    leaseMs: number,
  ) {
    const result = await this.write(
      `WITH claimed AS (
      UPDATE records thread SET data=data || jsonb_build_object('runToken',$4::text,'stopRunToken',NULL,'leaseUntil',clock_timestamp() + ($5::text || ' milliseconds')::interval),updated_at=now()
      WHERE owner=$1 AND kind='threads' AND id=$3 AND (data->>'runToken' IS NULL OR (data->>'leaseUntil')::timestamptz<=clock_timestamp())
      AND EXISTS (SELECT 1 FROM records message WHERE message.owner=thread.owner AND message.kind='conversation-inbox' AND message.id=$2 AND message.data->>'status'='accepted') RETURNING data
    ) UPDATE records SET data=data || '{"status":"dispatching"}'::jsonb,updated_at=now()
      WHERE owner=$1 AND kind='conversation-inbox' AND id=$2 AND data->>'status'='accepted' AND EXISTS(SELECT 1 FROM claimed) RETURNING data`,
      [owner, id, threadId, token, leaseMs],
    );
    return result.rows.length === 1;
  }
  async durableMutation<T>(
    owner: string,
    receiptId: string,
    bindingHash: string,
    mutations: {
      kind: string;
      id: string;
      expected?: Record<string, unknown>;
      value: Record<string, unknown>;
      mode: "insert" | "merge" | "replace";
    }[],
    events: Omit<ConversationEvent, "seq">[] = [],
    requireActive = false,
  ) {
    const result = await this.write(
      requireActive
        ? "SELECT openmuse_active_durable_mutation($1,$2,$3,$4::jsonb,$5::jsonb) AS data"
        : "SELECT openmuse_durable_mutation($1,$2,$3,$4::jsonb,$5::jsonb) AS data",
      [owner, receiptId, bindingHash, JSON.stringify(mutations), JSON.stringify(events)],
    );
    return result.rows[0].data as unknown as {
      status:
        | "applied"
        | "duplicate"
        | "binding_conflict"
        | "revision_conflict"
        | "paused"
        | "thread_deleted";
      values: T[];
      events: ConversationEvent[];
    };
  }
  /** Suppression and CAS share the owner transaction lock with automatic saves. */
  async memoryMutation(
    owner: string,
    receiptId: string,
    bindingHash: string,
    mutations: Parameters<Store["durableMutation"]>[3],
    allowRestoration: boolean,
  ) {
    await this.repairMemoryFingerprints(owner);
    mutations = mutations.map((mutation) => {
      if (mutation.kind === "memories" && typeof mutation.value.text === "string")
        return {
          ...mutation,
          value: { ...mutation.value, ...memoryFingerprintFields(mutation.value.text) },
        };
      return mutation;
    });
    const result = await this.write(
      "SELECT openmuse_memory_mutation($1,$2,$3,$4::jsonb,$5::boolean) AS data",
      [owner, receiptId, bindingHash, JSON.stringify(mutations), allowRestoration],
    );
    return result.rows[0].data as unknown as {
      status: "applied" | "duplicate" | "binding_conflict" | "revision_conflict" | "suppressed";
      values: AgentMemory[];
    };
  }
  async conversationEvents(
    owner: string,
    threadId: string,
    cursor: number,
    limit = 500,
    options: { latest?: boolean; summary?: boolean } = {},
  ) {
    const projected = options.summary
      ? `CASE WHEN data->>'kind'='agui' THEN jsonb_set(data,'{payload}',
          jsonb_build_object('type',data->'payload'->'type') || CASE
          WHEN data->'payload'->>'name'='conversation_delivery_error' THEN jsonb_build_object('name','conversation_delivery_error','value',jsonb_build_object('message',data->'payload'->'value'->'message'))
          ELSE '{}'::jsonb END) ELSE data END`
      : "data";
    const result = await this.db.query(
      `SELECT jsonb_build_object(
      'events',COALESCE((SELECT jsonb_agg(data ORDER BY seq) FROM (SELECT seq,${projected} AS data FROM conversation_events WHERE owner=$1 AND thread_id=$2 ${options.latest ? "AND $3::bigint >= 0" : "AND seq>$3"} ORDER BY seq ${options.latest ? "DESC" : "ASC"} LIMIT $4) tail),'[]'::jsonb),
      'head',COALESCE((SELECT max(seq) FROM conversation_events WHERE owner=$1 AND thread_id=$2),0)
    ) AS data`,
      [owner, threadId, cursor, limit],
    );
    return result.rows[0].data as unknown as { events: ConversationEvent[]; head: number };
  }
  async appendConversationEvent(owner: string, event: Omit<ConversationEvent, "seq">) {
    const result = await this.write(
      "SELECT openmuse_conversation_event($1,$2,$3,$4::jsonb) AS data",
      [owner, event.threadId, event.id, JSON.stringify(event)],
    );
    return result.rows[0].data as unknown as ConversationEvent;
  }
  private failedWrite = false;
  /** A caught SQL write error still invalidates an exit-zero stopped-writer snapshot. */
  get persistenceFailed() {
    return this.failedWrite;
  }
  constructor(private readonly db: Database) {}
  private async write(sql: string, params?: unknown[]) {
    try {
      return await this.db.query(sql, params);
    } catch (error) {
      this.failedWrite = true;
      throw error;
    }
  }
  async appendActionLog(owner: string, entry: ActionLogEntry): Promise<void> {
    await this.write(
      "INSERT INTO external_action_log(owner,id,time,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,id) DO NOTHING",
      [owner, entry.id, entry.time, JSON.stringify(entry)],
    );
  }
  async actionLog(
    owner: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ entries: ActionLogEntry[]; nextCursor?: string }> {
    limit = Math.min(200, Math.max(1, limit));
    const result = await this.db.query(
      "SELECT data FROM external_action_log WHERE owner=$1 AND ($2::text IS NULL OR (time,id)<(SELECT time,id FROM external_action_log WHERE owner=$1 AND id=$2)) ORDER BY time DESC,id DESC LIMIT $3",
      [owner, cursor ?? null, Math.min(200, Math.max(1, limit)) + 1],
    );
    const entries = result.rows.slice(0, limit).map((row) => row.data as unknown as ActionLogEntry);
    return { entries, ...(result.rows.length > limit && { nextCursor: entries.at(-1)?.id }) };
  }
  async unfinishedActionLog(
    cutoff = new Date().toISOString(),
    after?: { time: string; owner: string; id: string },
  ): Promise<{ owner: string; value: ActionLogEntry }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',start.owner,'value',start.data) AS data FROM external_action_log start WHERE start.data->>'result'='started' AND start.time <= $1::timestamptz AND ($2::timestamptz IS NULL OR (start.time,start.owner,start.id)>($2::timestamptz,$3::text,$4::text)) AND NOT EXISTS (SELECT 1 FROM external_action_log done WHERE done.owner=start.owner AND done.data->>'operationId'=start.data->>'operationId' AND done.data->>'result'<>'started') ORDER BY start.time,start.owner,start.id LIMIT 200",
      [cutoff, after?.time ?? null, after?.owner ?? null, after?.id ?? null],
    );
    return result.rows.map(
      (row) => row.data as unknown as { owner: string; value: ActionLogEntry },
    );
  }
  async get<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async notificationDelivery(
    owner: string,
    id: string,
    status: NonNullable<AgentNotification["nativeDelivery"]>,
  ) {
    // Parallel publishers may see an in-flight receipt. Keep final/uncertain
    // native status from being replaced by that stale pending observation.
    await this.write(
      "UPDATE records SET data=jsonb_set(data,'{nativeDelivery}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='notifications' AND id=$2 AND ($4::text<>'pending' OR COALESCE(data->>'nativeDelivery','pending')='pending') AND (COALESCE(data->>'nativeDelivery','')<>'outcome_unknown' OR $4::text='outcome_unknown')",
      [owner, id, JSON.stringify(status), status],
    );
  }
  /** Notification and its original eligible devices share one durable snapshot. */
  async insertNotification(owner: string, value: AgentNotification, platforms: string[]) {
    const result = await this.write(
      `WITH notice AS (
       INSERT INTO records(owner,kind,id,data) VALUES($1,'notifications',$2,$3::jsonb)
       ON CONFLICT DO NOTHING RETURNING data
      ), intent AS (
       INSERT INTO records(owner,kind,id,data)
       SELECT $1,'push-intents',$2,jsonb_build_object('id',$2::text,'status','pending','targets',
         (SELECT COALESCE(jsonb_agg(device.data ORDER BY device.id),'[]'::jsonb)
          FROM records device WHERE device.owner=$1 AND device.kind='push-devices'
          AND device.data->>'platform'=ANY($4::text[]))) FROM notice
       ON CONFLICT DO NOTHING
      ) SELECT data FROM notice`,
      [owner, value.id, JSON.stringify(value), platforms],
    );
    return (result.rows[0]?.data as unknown as AgentNotification | undefined) ?? null;
  }
  async pushDeliveries<T>(owner: string, notificationId: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind='push-deliveries' AND data->>'notificationId'=$2 ORDER BY id",
      [owner, notificationId],
    );
    return result.rows.map((row) => row.data as T);
  }
  /** Same-token refresh keeps consent identity; replacement/re-enrollment gets a new one. */
  async registerPushDevice<T extends { id: string }>(owner: string, value: T): Promise<T> {
    const result = await this.write(
      `INSERT INTO records AS registration(owner,kind,id,data) VALUES($1,'push-devices',$2,$3::jsonb)
       ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data || jsonb_build_object('registrationId',
         CASE WHEN registration.data->>'token'=excluded.data->>'token'
              AND registration.data->>'platform'=excluded.data->>'platform'
         THEN COALESCE(registration.data->'registrationId',excluded.data->'registrationId')
         ELSE excluded.data->'registrationId' END),updated_at=now() RETURNING data`,
      [owner, value.id, JSON.stringify(value)],
    );
    return result.rows[0].data as T;
  }
  /** Claim only the still-consenting original registration, never a replacement. */
  async claimPushDelivery<T extends { id: string }>(
    owner: string,
    value: T,
    device: { id: string; token: string; platform: string; registrationId?: string },
  ): Promise<T | null> {
    const result = await this.write(
      `WITH eligible_device AS MATERIALIZED (
         SELECT 1 FROM records WHERE owner=$1 AND kind='push-devices' AND id=$4
           AND data->>'token'=$5 AND data->>'platform'=$6
           AND data->>'registrationId' IS NOT DISTINCT FROM $7::text
       ), inserted AS (
         INSERT INTO records(owner,kind,id,data) SELECT $1,'push-deliveries',$2,$3::jsonb
         WHERE EXISTS (SELECT 1 FROM eligible_device)
         ON CONFLICT DO NOTHING RETURNING data
       ), resumed AS (
         UPDATE records SET data=$3::jsonb,updated_at=now()
         WHERE owner=$1 AND kind='push-deliveries' AND id=$2 AND data->>'status'='pending'
           AND EXISTS (SELECT 1 FROM eligible_device) RETURNING data
       ) SELECT data FROM inserted UNION ALL SELECT data FROM resumed LIMIT 1`,
      [
        owner,
        value.id,
        JSON.stringify(value),
        device.id,
        device.token,
        device.platform,
        device.registrationId ?? null,
      ],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async takePushDevice(
    owner: string,
    device: { id: string; token: string; platform: string; registrationId?: string },
  ): Promise<void> {
    await this.write(
      "DELETE FROM records WHERE owner=$1 AND kind='push-devices' AND id=$2 AND data->>'token'=$3 AND data->>'platform'=$4 AND data->>'registrationId' IS NOT DISTINCT FROM $5::text",
      [owner, device.id, device.token, device.platform, device.registrationId ?? null],
    );
  }
  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  /** Presentation archive keeps canonical records available to receipts and reconciliation. */
  async visibleRecords<T>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>'historyHiddenAt' IS NULL ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  async recordPage<T>(
    owner: string,
    kind: string,
    options: {
      cursor?: string;
      limit?: number;
      field?: string;
      value?: string;
      order?: "createdAt" | "updatedAt";
      visibleOnly?: boolean;
    } = {},
  ) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 40));
    const timestamp = options.order === "updatedAt" ? "updatedAt" : "createdAt";
    const result = await this.db.query(
      `SELECT data FROM records WHERE owner=$1 AND kind=$2
       AND (NOT $8::boolean OR data->>'historyHiddenAt' IS NULL)
       AND ($3::text IS NULL OR (NOT $7::boolean AND id>$3) OR ($7::boolean AND (
         data->>'${timestamp}'<(SELECT data->>'${timestamp}' FROM records WHERE owner=$1 AND kind=$2 AND id=$3) OR
         (data->>'${timestamp}'=(SELECT data->>'${timestamp}' FROM records WHERE owner=$1 AND kind=$2 AND id=$3) AND id>$3))))
       AND ($5::text IS NULL OR data->>$5=$6)
       ORDER BY CASE WHEN $7::boolean THEN data->>'${timestamp}' ELSE NULL END DESC,id LIMIT $4`,
      [
        owner,
        kind,
        options.cursor ?? null,
        limit + 1,
        options.field ?? null,
        options.value ?? null,
        !!options.order,
        options.visibleOnly === true,
      ],
    );
    const entries = result.rows.slice(0, limit).map((row) => row.data as T);
    return {
      entries,
      ...(result.rows.length > limit
        ? { nextCursor: (result.rows[limit - 1].data as { id: string }).id }
        : {}),
    };
  }
  async revisionPage<T>(
    owner: string,
    kind: string,
    entityId: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const result = await this.db.query(
      `SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>'entityId'=$3
       AND ($4::text IS NULL OR (data->>'revision')::integer <
         (SELECT (data->>'revision')::integer FROM records WHERE owner=$1 AND kind=$2 AND id=$4 AND data->>'entityId'=$3))
       ORDER BY (data->>'revision')::integer DESC LIMIT $5`,
      [owner, kind, entityId, options.cursor ?? null, limit + 1],
    );
    const entries = result.rows
      .slice(0, limit)
      .map((row) => row.data as unknown as RevisionEntry<T>);
    return { entries, ...(result.rows.length > limit ? { nextCursor: entries.at(-1)?.id } : {}) };
  }
  /** Stable, bounded source scan. A cursor never claims coverage of an omitted tail. */
  async listPage<T>(owner: string, kind: string, limit = 50, after?: string) {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND ($3::text IS NULL OR id>$3) ORDER BY id LIMIT $4",
      [owner, kind, after ?? null, bounded + 1],
    );
    const values = result.rows.slice(0, bounded).map((row) => row.data as T);
    return {
      values,
      complete: result.rows.length <= bounded,
      ...(result.rows.length > bounded ? { cursor: (values.at(-1) as { id: string }).id } : {}),
    };
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.write(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return value;
  }
  async resetRejectedComputerCommand(owner: string, id: string, binding: string): Promise<boolean> {
    const result = await this.write(
      `DELETE FROM records
       WHERE owner=$1 AND kind='computer-commands' AND id=$2
         AND data->>'binding'=$3 AND data->>'status'='rejected_not_dispatched'
       RETURNING id`,
      [owner, id, binding],
    );
    return result.rows.length === 1;
  }
  /** Artifact ACKs may arrive after a newer local version. Publish metadata
   * monotonically with a database CAS; old transport snapshots cannot regress it.
   */
  async publishNativeArtifact<T extends { id: string; generation: number }>(
    owner: string,
    value: T,
  ): Promise<T | null> {
    const result = await this.write(
      `INSERT INTO records AS artifact(owner,kind,id,data)
      VALUES($1,'native-artifacts',$2,$3::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE
      SET data=excluded.data,updated_at=now()
      WHERE COALESCE((artifact.data->>'generation')::bigint,0)<($3::jsonb->>'generation')::bigint
        AND artifact.data->>'executorId'=$3::jsonb->>'executorId' RETURNING data`,
      [owner, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.write("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [owner, kind, id]);
  }
  async removeIf(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.write(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data",
      [owner, kind, id, JSON.stringify(expected)],
    );
    return result.rows.length === 1;
  }
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.write(
      "UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data",
      [owner, kind, id, JSON.stringify(expected), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async compareAndSwapTask<T>(
    owner: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.write(
      `UPDATE records SET data=(data || $4::jsonb) || jsonb_build_object('state',
          CASE WHEN $4::jsonb ? 'state' THEN
            ((COALESCE(data->'state','{}'::jsonb) || ($4::jsonb->'state')) ||
              jsonb_strip_nulls(jsonb_build_object(
                'desiredRevision',data->'state'->'desiredRevision',
                'mailboxSeq',data->'state'->'mailboxSeq',
                'appliedRevision',data->'state'->'appliedRevision',
                'appliedMailboxSeq',data->'state'->'appliedMailboxSeq',
                'directives',data->'state'->'directives',
                'timingRevision',data->'state'->'timingRevision')))
          ELSE data->'state' END),updated_at=now()
       WHERE owner=$1 AND kind='tasks' AND id=$2 AND data @> $3::jsonb RETURNING data`,
      [owner, id, JSON.stringify(expected), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /** Indexed work queue; priority ordering is applied by the scheduler after this bounded read. */
  async eligibleTasks<T>(now: string, limit = 200): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      `SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records
       WHERE kind='tasks' AND (
         data->>'status' IN ('queued','waiting_resource','waiting_global_pause') OR
         (data->>'status'='scheduled' AND (data->>'nextRunAt')::timestamptz <= $1::timestamptz) OR
         (data->>'status'='waiting_job' AND COALESCE((data->>'nextRunAt')::timestamptz,'-infinity'::timestamptz) <= $1::timestamptz) OR
         (data->>'status'='waiting_provider' AND data->>'nextRunAt' IS NOT NULL AND (data->>'nextRunAt')::timestamptz <= $1::timestamptz) OR
         (data->>'status'='running' AND (data->>'leaseUntil')::timestamptz <= $1::timestamptz) OR
         data->>'status'='waiting_approval' OR
         (data->>'status'='paused' AND jsonb_typeof(data->'state'->'awaitingBrowserSessionId')='string')
       ) ORDER BY updated_at ASC,id LIMIT $2`,
      [now, Math.min(1000, Math.max(1, limit))],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }
  async claimWorkAdmission(
    taskId: string,
    workClass: WorkClass,
    rootTaskId: string,
    claimant: string,
    now: string,
    expiresAt: string,
  ): Promise<boolean> {
    const result = await this.write(
      "SELECT openmuse_claim_work_admission($1::text,$2::text,$3::text,$4::text,$5::timestamptz,$6::text) AS admitted",
      [taskId, workClass, rootTaskId, claimant, now, expiresAt],
    );
    return (result.rows[0] as unknown as { admitted?: boolean } | undefined)?.admitted === true;
  }
  async updateDeploymentMaintenance<T>(
    owner: string,
    id: string,
    operation: "begin" | "renew" | "finish",
    now: string,
    expiresAt: string,
  ): Promise<T | null> {
    const result = await this.write(
      "SELECT openmuse_deployment_maintenance($1::text,$2::text,$3::text,$4::timestamptz,$5::text) AS data",
      [owner, id, operation, now, expiresAt],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async renewWorkAdmission(
    taskId: string,
    claimant: string,
    now: string,
    expiresAt: string,
  ): Promise<boolean> {
    const result = await this.write(
      `UPDATE records SET data=CASE WHEN data->>'hold'='true' THEN data
           ELSE jsonb_set(data,'{expiresAt}',to_jsonb($4::text)) END,updated_at=now()
       WHERE owner='__runtime__' AND kind='work-admissions' AND id=$1
         AND data->>'claimant'=$2
         AND (data->>'hold'='true' OR COALESCE((data->>'expiresAt')::timestamptz>$3::timestamptz,false))
       RETURNING id`,
      [taskId, claimant, now, expiresAt],
    );
    return result.rows.length === 1;
  }
  async rebindWorkAdmission(taskId: string, claimant: string): Promise<boolean> {
    const result = await this.write(
      `UPDATE records SET data=jsonb_set(data,'{claimant}',to_jsonb($2::text)),updated_at=now()
       WHERE owner='__runtime__' AND kind='work-admissions' AND id=$1
         AND data->>'hold'='true'
         AND EXISTS (SELECT 1 FROM records task WHERE task.kind='tasks' AND task.id=$1
           AND task.data->>'status'='running') RETURNING id`,
      [taskId, claimant],
    );
    return result.rows.length === 1;
  }
  async holdWorkAdmission(taskId: string, claimant: string): Promise<boolean> {
    const result = await this.write(
      `UPDATE records SET data=data || '{"hold":true,"expiresAt":null}'::jsonb,updated_at=now()
       WHERE owner='__runtime__' AND kind='work-admissions' AND id=$1 AND data->>'claimant'=$2 RETURNING id`,
      [taskId, claimant],
    );
    return result.rows.length === 1;
  }
  async holdWorkAdmissionForRunningTask(taskId: string, claimant: string): Promise<boolean> {
    const result = await this.write(
      `UPDATE records SET data=data || '{"hold":true,"expiresAt":null}'::jsonb,updated_at=now()
       WHERE owner='__runtime__' AND kind='work-admissions' AND id=$1 AND data->>'claimant'=$2
         AND EXISTS (SELECT 1 FROM records task WHERE task.kind='tasks' AND task.id=$1
           AND task.data->>'status'='running') RETURNING id`,
      [taskId, claimant],
    );
    return result.rows.length === 1;
  }
  async releaseWorkAdmission(taskId: string, claimant: string): Promise<boolean> {
    const result = await this.write(
      "DELETE FROM records WHERE owner='__runtime__' AND kind='work-admissions' AND id=$1 AND data->>'claimant'=$2 RETURNING id",
      [taskId, claimant],
    );
    return result.rows.length === 1;
  }
  async releaseHeldWorkAdmission(taskId: string): Promise<boolean> {
    const result = await this.write(
      `WITH task AS MATERIALIZED (
         SELECT owner,id FROM records
         WHERE kind='tasks' AND id=$1
           AND data->>'status' IN ('paused','cancelled','failed','waiting_input','succeeded')
         FOR UPDATE
       )
       DELETE FROM records admission USING task
       WHERE admission.owner='__runtime__' AND admission.kind='work-admissions'
         AND admission.id=$1
       RETURNING admission.id`,
      [taskId],
    );
    return result.rows.length === 1;
  }
  async getRuntimePause(): Promise<RuntimePauseState | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner='__runtime__' AND kind='runtime-pause' AND id='global'",
    );
    return (result.rows[0]?.data as RuntimePauseState | undefined) ?? null;
  }
  async setRuntimePause(
    paused: boolean,
    expectedRevision: number,
    changedAt: string,
  ): Promise<RuntimePauseState | null> {
    const result = await this.write(
      "SELECT openmuse_set_runtime_pause($1::boolean,$2::integer,$3::text) AS data",
      [paused, expectedRevision, changedAt],
    );
    return (result.rows[0]?.data as RuntimePauseState | undefined) ?? null;
  }
  async acquireResourceLeases(
    owner: string,
    taskId: string,
    requests: (ResourceRequest & { id: string })[],
    now: string,
    expiresAt: string,
  ): Promise<ResourceLease[] | null> {
    const result = await this.write(
      "SELECT openmuse_acquire_resource_leases($1::text,$2::text,$3::jsonb,$4::timestamptz,$5::text) AS leases",
      [owner, taskId, JSON.stringify(requests), now, expiresAt],
    );
    const leases = (result.rows[0] as unknown as { leases?: unknown } | undefined)?.leases;
    if (!Array.isArray(leases)) return null;
    return leases as ResourceLease[];
  }
  async renewResourceLease(
    lease: ResourceLease,
    now: string,
    expiresAt: string,
  ): Promise<ResourceLease | null> {
    const result = await this.write(
      `UPDATE records SET data=jsonb_set(data,'{expiresAt}',to_jsonb($4::text)),updated_at=now()
       WHERE owner='__runtime__' AND kind='resource-leases' AND id=$1
         AND (data->>'fence')::bigint=$2
         AND (data->>'hold'='true' OR (data->>'expiresAt')::timestamptz>$3::timestamptz)
       RETURNING jsonb_build_object('id',data->>'id','fence',(data->>'fence')::bigint,'expiresAt',data->>'expiresAt') AS data`,
      [lease.id, lease.fence, now, expiresAt],
    );
    return (result.rows[0]?.data as ResourceLease | undefined) ?? null;
  }
  async releaseResourceLease(lease: ResourceLease): Promise<boolean> {
    const result = await this.write(
      "DELETE FROM records WHERE owner='__runtime__' AND kind='resource-leases' AND id=$1 AND (data->>'fence')::bigint=$2 RETURNING id",
      [lease.id, lease.fence],
    );
    return result.rows.length === 1;
  }
  async releaseTaskResourceLeases(taskId: string): Promise<void> {
    await this.write(
      "DELETE FROM records WHERE owner='__runtime__' AND kind='resource-leases' AND data->>'taskId'=$1",
      [taskId],
    );
  }
  async holdTaskResourceLeases(taskId: string): Promise<void> {
    await this.write(
      `UPDATE records SET data=data || '{"hold":true}'::jsonb,updated_at=now()
       WHERE owner='__runtime__' AND kind='resource-leases' AND data->>'taskId'=$1`,
      [taskId],
    );
  }
  async holdResourceLease(lease: ResourceLease): Promise<boolean> {
    const result = await this.write(
      `UPDATE records SET data=data || '{"hold":true}'::jsonb,updated_at=now()
       WHERE owner='__runtime__' AND kind='resource-leases' AND id=$1
         AND (data->>'fence')::bigint=$2
         AND (data->>'hold'='true' OR (data->>'expiresAt')::timestamptz>now()) RETURNING id`,
      [lease.id, lease.fence],
    );
    return result.rows.length === 1;
  }
  async resourceLeasesForTask(taskId: string): Promise<ResourceLease[]> {
    const result = await this.db.query(
      `SELECT jsonb_build_object('id',data->>'id','fence',(data->>'fence')::bigint,'expiresAt',data->>'expiresAt') AS data
       FROM records WHERE owner='__runtime__' AND kind='resource-leases' AND data->>'taskId'=$1 ORDER BY id`,
      [taskId],
    );
    return result.rows.map((row) => row.data as ResourceLease);
  }
  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    const result = await this.write(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /** Atomic append avoids losing streamed events to another database connection. */
  async appendRecordEvent(owner: string, id: string, event: unknown): Promise<void> {
    if (event && typeof event === "object" && "type" in event && event.type === "RUN_STARTED") {
      const { input: _input, ...publicEvent } = event as Record<string, unknown>;
      event = publicEvent;
    }
    if (Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024)
      throw new Error("Conversation event exceeds the 1 MiB retention envelope");
    await this.write("SELECT openmuse_thread_event($1,$2,$3::jsonb) AS data", [
      owner,
      id,
      JSON.stringify(event),
    ]);
  }
  /** Database-clock lease shared by every API process using Postgres. */
  async claimThread(
    owner: string,
    id: string,
    runToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.write(
      `UPDATE records SET data=data || jsonb_build_object('runToken',$3::text,'stopRunToken',NULL,'leaseUntil',clock_timestamp() + ($4::text || ' milliseconds')::interval),updated_at=now()
       WHERE owner=$1 AND kind='threads' AND id=$2 AND data->>'deletedAt' IS NULL AND (data->>'runToken' IS NULL OR (data->>'leaseUntil')::timestamptz<=clock_timestamp()) RETURNING data`,
      [owner, id, runToken, leaseMs],
    );
    return result.rows.length === 1;
  }
  async deleteThread(owner: string, id: string, nextMain: string) {
    const result = await this.write("SELECT openmuse_delete_thread($1,$2,$3) AS data", [
      owner,
      id,
      nextMain,
    ]);
    return result.rows[0].data as unknown as {
      status: "deleted" | "not_found" | "busy";
      mainThreadId?: string | null;
    };
  }
  async renewThread(
    owner: string,
    id: string,
    runToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await this.write(
      `UPDATE records SET data=data || jsonb_build_object('leaseUntil',clock_timestamp() + ($4::text || ' milliseconds')::interval)
       WHERE owner=$1 AND kind='threads' AND id=$2 AND data->>'runToken'=$3 AND (data->>'leaseUntil')::timestamptz>clock_timestamp() RETURNING data`,
      [owner, id, runToken, leaseMs],
    );
    return result.rows.length === 1;
  }
  async threadLeaseActive(owner: string, id: string): Promise<boolean> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind='threads' AND id=$2 AND data->>'runToken' IS NOT NULL AND (data->>'leaseUntil')::timestamptz>clock_timestamp()",
      [owner, id],
    );
    return result.rows.length === 1;
  }
  /** One MVCC snapshot ties the event tail to the matching run's lease state. */
  async threadSnapshot<T>(
    owner: string,
    id: string,
    onlyRunning = false,
  ): Promise<{ runs: T[]; activeRunToken: string | null }> {
    const result = await this.db.query(
      `WITH ordered AS (
         SELECT run.id,run.data,row_number() OVER (ORDER BY run.data->>'createdAt' DESC,run.id DESC) AS position
         FROM records run WHERE run.owner=$1 AND run.kind='thread-runs' AND run.data->>'threadId'=$2
           AND (NOT $3::boolean OR run.data->>'status'='running')
       ), projected AS (
         SELECT id,CASE WHEN data->>'status'='running' THEN data ELSE
           (CASE WHEN position=1 THEN (data - 'inputMessages' - 'initialState') ||
             CASE WHEN data ? 'messages' THEN '{}'::jsonb ELSE jsonb_build_object('messages',
               COALESCE((SELECT jsonb_agg(message.data ORDER BY message.position) FROM thread_messages message WHERE message.owner=$1 AND message.thread_id=$2),'[]'::jsonb)) END
             ELSE data - 'messages' - 'inputMessages' - 'state' - 'initialState' END)
           || jsonb_build_object('events',COALESCE((SELECT jsonb_agg(
             CASE WHEN event->>'type'='RUN_STARTED' THEN event - 'input' ELSE event END ORDER BY n)
             FROM jsonb_array_elements(COALESCE(data->'events','[]'::jsonb)) WITH ORDINALITY AS e(event,n)), '[]'::jsonb)) END AS data
         FROM ordered
       ) SELECT jsonb_build_object(
         'runs',COALESCE((SELECT jsonb_agg(run.data ORDER BY run.data->>'createdAt',run.id) FROM projected run),'[]'::jsonb),
         'activeRunToken',CASE WHEN (data->>'leaseUntil')::timestamptz>clock_timestamp() THEN data->>'runToken' ELSE NULL END
       ) AS data FROM records WHERE owner=$1 AND kind='threads' AND id=$2`,
      [owner, id, onlyRunning],
    );
    return (
      (result.rows[0]?.data as { runs: T[]; activeRunToken: string | null } | undefined) ?? {
        runs: [],
        activeRunToken: null,
      }
    );
  }
  async latestUncompactedThreadRun<T>(owner: string, threadId: string): Promise<T | undefined> {
    const result = await this.db.query(
      `WITH latest AS (SELECT data FROM records WHERE owner=$1 AND kind='thread-runs' AND data->>'threadId'=$2
         ORDER BY data->>'createdAt' DESC,id DESC LIMIT 1)
       SELECT data FROM latest WHERE data->>'status'='running' OR data ? 'messages'`,
      [owner, threadId],
    );
    return result.rows[0]?.data as unknown as T | undefined;
  }
  /** UI reconnects read one run and a recent display page, never all historic run events. */
  async threadDisplaySnapshot<T>(
    owner: string,
    threadId: string,
    limit: number,
    after?: { id: string; eventCount: number },
  ): Promise<{ run?: T; eventCount: number; activeRunToken: string | null }> {
    const result = await this.db.query(
      `WITH latest AS (
        SELECT data FROM records WHERE owner=$1 AND kind='thread-runs' AND data->>'threadId'=$2
          ORDER BY data->>'createdAt' DESC,id DESC LIMIT 1
      ), recent AS (
        SELECT position,data FROM thread_messages WHERE owner=$1 AND thread_id=$2 ORDER BY position DESC LIMIT $3
      ) SELECT jsonb_build_object(
        'run',(SELECT (data - 'messages' - 'inputMessages' - 'events') || jsonb_build_object(
          'messages',CASE WHEN data ? 'messages' THEN COALESCE((SELECT jsonb_agg(value ORDER BY n)
            FROM jsonb_array_elements(data->'messages') WITH ORDINALITY e(value,n)
            WHERE n>jsonb_array_length(data->'messages')-$3),'[]'::jsonb)
            ELSE COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM recent),'[]'::jsonb) END,
          'inputMessages',COALESCE((SELECT jsonb_agg(value ORDER BY n)
            FROM jsonb_array_elements(COALESCE(data->'inputMessages','[]'::jsonb)) WITH ORDINALITY e(value,n)
            WHERE n>jsonb_array_length(COALESCE(data->'inputMessages','[]'::jsonb))-$3),'[]'::jsonb),
          'events',COALESCE((SELECT jsonb_agg(value ORDER BY n)
            FROM jsonb_array_elements(COALESCE(data->'events','[]'::jsonb)) WITH ORDINALITY e(value,n)
            WHERE (data->>'id'=$4 AND n>$5) OR (data->>'id' IS DISTINCT FROM $4
              AND (data->>'status'='running' OR value->>'type' IN ('CUSTOM','RUN_ERROR')))), '[]'::jsonb)) FROM latest),
        'eventCount',COALESCE((SELECT jsonb_array_length(COALESCE(data->'events','[]'::jsonb)) FROM latest),0),
        'activeRunToken',CASE WHEN (data->>'leaseUntil')::timestamptz>clock_timestamp() THEN data->>'runToken' ELSE NULL END
      ) AS data FROM records WHERE owner=$1 AND kind='threads' AND id=$2 AND data->>'deletedAt' IS NULL`,
      [owner, threadId, limit, after?.id ?? null, after?.eventCount ?? 0],
    );
    return (
      (result.rows[0]?.data as unknown as {
        run?: T;
        eventCount: number;
        activeRunToken: string | null;
      }) ?? { eventCount: 0, activeRunToken: null }
    );
  }
  async compactThread(owner: string, threadId: string): Promise<boolean> {
    const result = await this.write("SELECT openmuse_compact_thread($1,$2) AS data", [
      owner,
      threadId,
    ]);
    return (result.rows[0]?.data as unknown) === true;
  }
  async latestThreadError(
    owner: string,
    threadId: string,
  ): Promise<{ runId: string; message: string } | undefined> {
    const result = await this.db.query(
      `SELECT jsonb_build_object('runId',data->>'runId','message',event->>'message') AS data
      FROM records CROSS JOIN LATERAL jsonb_array_elements(COALESCE(data->'events','[]'::jsonb)) event
      WHERE owner=$1 AND kind='thread-runs' AND data->>'threadId'=$2 AND data->>'status'='interrupted'
        AND event->>'type'='RUN_ERROR' ORDER BY data->>'createdAt' DESC,id DESC LIMIT 1`,
      [owner, threadId],
    );
    return result.rows[0]?.data as unknown as { runId: string; message: string } | undefined;
  }
  async threadContextMessages(
    owner: string,
    threadId: string,
    requiredOperationIds: readonly string[] = [],
  ) {
    const result = await this.db.query(
      `WITH recent AS (
      SELECT position,data FROM thread_messages WHERE owner=$1 AND thread_id=$2 ORDER BY position DESC LIMIT 200
    ), required AS (
      SELECT position,data FROM thread_messages WHERE owner=$1 AND thread_id=$2 AND
       (data->>'toolCallId'=ANY($3::text[]) OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(data->'toolCalls','[]'::jsonb)) call WHERE call->>'id'=ANY($3::text[])))
    ) SELECT data FROM (SELECT * FROM recent UNION SELECT * FROM required) messages ORDER BY position`,
      [owner, threadId, requiredOperationIds],
    );
    return result.rows.map((row) => row.data as unknown as ThreadMessagePage["messages"][number]);
  }
  async threadMessagePage(
    owner: string,
    threadId: string,
    options: { cursor?: string; limit?: number; direction?: "forward" | "backward" } = {},
  ): Promise<ThreadMessagePage> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const cursorValid = options.cursor
      ? (
          await this.db.query(
            "SELECT data FROM thread_messages WHERE owner=$1 AND thread_id=$2 AND id=$3",
            [owner, threadId, options.cursor],
          )
        ).rows.length > 0
      : true;
    const backward = options.direction === "backward";
    const result = await this.db.query(
      `SELECT data FROM thread_messages WHERE owner=$1 AND thread_id=$2
      AND ($3::text IS NULL OR position${backward ? "<" : ">"}(SELECT position FROM thread_messages WHERE owner=$1 AND thread_id=$2 AND id=$3))
      ORDER BY position ${backward ? "DESC" : "ASC"} LIMIT $4`,
      [owner, threadId, cursorValid ? (options.cursor ?? null) : null, limit + 1],
    );
    const messages = result.rows
      .slice(0, limit)
      .map((row) => row.data as unknown as ThreadMessagePage["messages"][number]);
    if (backward) messages.reverse();
    return {
      messages,
      snapshotRequired: !cursorValid,
      ...(result.rows.length > limit
        ? backward
          ? { previousCursor: messages[0]?.id }
          : { nextCursor: messages.at(-1)?.id }
        : {}),
    };
  }
  /** Serialized fixture bytes, not PostgreSQL allocation or host RAM measurements. */
  async threadStorageBytes(owner: string, threadId: string): Promise<number> {
    const result = await this.db.query(
      `SELECT jsonb_build_object('bytes',
      COALESCE((SELECT sum(octet_length(data::text)) FROM records WHERE owner=$1 AND kind='thread-runs' AND data->>'threadId'=$2),0)+
      COALESCE((SELECT sum(octet_length(data::text)) FROM thread_messages WHERE owner=$1 AND thread_id=$2),0)) AS data`,
      [owner, threadId],
    );
    return Number(result.rows[0].data.bytes);
  }
  /** Recover the run and release only its matching lease in one crash-atomic SQL statement. */
  async recoverThreadRun(
    owner: string,
    threadId: string,
    token: string,
    expectedEvents: unknown[],
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.write(
      "SELECT openmuse_thread_recovery($1,$2,$3,$4::jsonb,$5::jsonb) AS data",
      [owner, threadId, token, JSON.stringify(expectedEvents), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as unknown) === true;
  }
  async expireThreadLease(owner: string, id: string, token: string): Promise<boolean> {
    const result = await this.write(
      `UPDATE records SET data=data || '{"runToken":null,"leaseUntil":null}'::jsonb
       WHERE owner=$1 AND kind='threads' AND id=$2 AND data->>'runToken'=$3 AND (data->>'leaseUntil')::timestamptz<=clock_timestamp() RETURNING data`,
      [owner, id, token],
    );
    return result.rows.length === 1;
  }
  private readonly memoryRepairs = new Map<string, Promise<void>>();
  /** Bounded legacy repair, without changing revision, history or pagination timestamps. */
  repairMemoryFingerprints(owner: string): Promise<void> {
    const pending = this.memoryRepairs.get(owner);
    if (pending) return pending;
    const repair = this.repairMemoryBatch(owner).finally(() => this.memoryRepairs.delete(owner));
    this.memoryRepairs.set(owner, repair);
    return repair;
  }
  private async repairMemoryBatch(owner: string) {
    let cursor: string | null = null;
    for (;;) {
      const result = await this.db.query(
        `SELECT jsonb_build_object('id',id,'text',data->'text') AS data FROM records WHERE owner=$1 AND kind='memories'
         AND NOT openmuse_memory_fingerprint_valid(data)
         AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 100`,
        [owner, cursor],
      );
      if (!result.rows.length) return;
      const repairs = result.rows.flatMap(({ data }) =>
        typeof data.text === "string"
          ? [{ id: data.id, text: data.text, ...memoryFingerprintFields(data.text) }]
          : [],
      );
      if (repairs.length)
        await this.write(
          `UPDATE records fact SET data=fact.data ||
          (repair - 'id' - 'text') || jsonb_build_object('suppressionOverride',
            CASE WHEN fact.data->>'suppressionOverride'=repair->>'fingerprint'
              THEN fact.data->>'suppressionOverride' ELSE NULL END)
         FROM jsonb_array_elements($2::jsonb) repair
         WHERE fact.owner=$1 AND fact.kind='memories' AND fact.id=repair->>'id'
         AND fact.data->>'text'=repair->>'text'
         AND NOT openmuse_memory_fingerprint_valid(fact.data)`,
          [owner, JSON.stringify(repairs)],
        );
      cursor = result.rows.at(-1)?.data.id as string;
      if (result.rows.length < 100) return;
    }
  }
  async findMemories(
    owner: string,
    query: string,
    limit: number,
    now = new Date().toISOString(),
    cursor?: string,
    includeInactive = false,
    status?: "active" | "forgotten" | "expired",
  ): Promise<AgentMemory[]> {
    await this.repairMemoryFingerprints(owner);
    const result = await this.db.query(
      `WITH matched AS (SELECT data,id,updated_at,
       CASE WHEN $2='' THEN 0 ELSE ts_rank_cd(openmuse_search_vector(data->>'text'),openmuse_search_query($2)) END AS score
       FROM records fact WHERE owner=$1 AND kind='memories'
       AND ($6::boolean OR (openmuse_memory_fingerprint_valid(data) AND COALESCE(data->>'status','active')='active'
       AND (data->>'validUntil' IS NULL OR (data->>'validUntil')::timestamptz>$4::timestamptz)
       AND NOT EXISTS(SELECT 1 FROM records suppression WHERE suppression.owner=fact.owner
         AND suppression.kind='memory-suppressions'
         AND suppression.id=fact.data->>'fingerprint'
         AND fact.data->>'suppressionOverride' IS DISTINCT FROM suppression.id)))
       AND ($7::text IS NULL OR
         ($7='forgotten' AND data->>'status'='forgotten') OR
         ($7='active' AND COALESCE(data->>'status','active')='active' AND (data->>'validUntil' IS NULL OR (data->>'validUntil')::timestamptz>$4::timestamptz)) OR
         ($7='expired' AND COALESCE(data->>'status','active')='active' AND (data->>'validUntil')::timestamptz<=$4::timestamptz))
       AND ($2='' OR openmuse_search_vector(data->>'text') @@ openmuse_search_query($2) OR id=$2)),
       ranked AS (SELECT data,id,row_number() OVER (ORDER BY score DESC,updated_at DESC,id DESC) AS position FROM matched)
       SELECT data FROM ranked WHERE ($5::text IS NULL OR position>(SELECT position FROM ranked WHERE id=$5))
       ORDER BY position LIMIT $3`,
      [
        owner,
        query,
        Math.min(101, Math.max(1, limit)),
        now,
        cursor ?? null,
        includeInactive,
        status ?? null,
      ],
    );
    return result.rows.map((row) => row.data as unknown as AgentMemory);
  }
  /** Fact IDs survive edits; deduplication compares the current text atomically. */
  async saveMemory(owner: string, value: AgentMemory): Promise<AgentMemory> {
    await this.repairMemoryFingerprints(owner);
    value = { ...value, ...memoryFingerprintFields(value.text) };
    const result = await this.write("SELECT openmuse_save_memory($1,$2::jsonb) AS data", [
      owner,
      JSON.stringify(value),
    ]);
    const saved = result.rows[0].data;
    if (saved.status === "repair_pending")
      throw new AppError("Memory changed during migration. Retry the save", 409);
    return saved as unknown as AgentMemory;
  }
  /** Durable sources survive model context trimming; reservations coalesce review jobs. */
  async learningReviewSources(owner: string, sources: { kind: string; id: string }[]) {
    const result = await this.db.query(
      `SELECT jsonb_build_object('kind',source.kind,'value',source.data) AS data
       FROM records source JOIN jsonb_to_recordset($2::jsonb) proof(kind text,id text)
         ON source.kind=proof.kind AND source.id=proof.id
       WHERE source.owner=$1 AND source.data->>'learningExcluded' IS DISTINCT FROM 'true'
       AND ((source.kind='tasks' AND source.data->>'deletedAt' IS NULL
         AND source.data->>'status'='succeeded' AND source.data->'completion'->>'status'='verified')
         OR (source.kind='conversation-inbox' AND source.data->>'status' IN ('finished','interrupted')
           AND NOT EXISTS(SELECT 1 FROM records thread WHERE thread.owner=$1 AND thread.kind='threads'
             AND thread.id=source.data->>'threadId' AND thread.data->>'deletedAt' IS NOT NULL)))`,
      [owner, JSON.stringify(sources)],
    );
    return result.rows.map(
      (row) =>
        row.data as unknown as { kind: string; value: Record<string, unknown> & { id: string } },
    );
  }
  async learningCandidates(owner: string, limit = 8) {
    const result = await this.db.query(
      `SELECT jsonb_build_object('kind',source.kind,'value',source.data) AS data FROM records source WHERE source.owner=$1
       AND source.data->>'learningExcluded' IS DISTINCT FROM 'true'
       AND ((source.kind='conversation-inbox' AND source.data->>'status' IN ('finished','interrupted')
         AND NOT EXISTS(SELECT 1 FROM records thread WHERE thread.owner=$1 AND thread.kind='threads'
           AND thread.id=source.data->>'threadId' AND thread.data->>'deletedAt' IS NOT NULL))
         OR (source.kind='tasks' AND source.data->>'status'='succeeded'
           AND source.data->>'deletedAt' IS NULL
           AND source.data->'completion'->>'status'='verified'
           AND source.data->'input'->>'internalActivity' IS DISTINCT FROM 'true'
           AND NOT (source.data->'input' ? 'proactivityCycleId')))
       AND NOT EXISTS(SELECT 1 FROM records seen WHERE seen.owner=source.owner
         AND seen.kind='learning-sources' AND seen.id=source.kind || ':' || source.id)
       ORDER BY source.data->>'createdAt',source.id LIMIT $2`,
      [owner, Math.min(20, limit)],
    );
    return result.rows.map(
      (row) =>
        row.data as unknown as { kind: string; value: Record<string, unknown> & { id: string } },
    );
  }
  async memorySourceSuppressed(owner: string, messageIds: string[]) {
    const result = await this.db.query(
      `SELECT 1 FROM records fact WHERE owner=$1 AND kind='memories' AND data->>'status'='forgotten'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'evidence','[]'::jsonb)) evidence
         WHERE evidence->>'messageId'=ANY($2::text[])) LIMIT 1`,
      [owner, messageIds],
    );
    return result.rows.length > 0;
  }
  async learningConversation(owner: string, threadIds: string[]) {
    const result = await this.db.query(
      `SELECT data FROM records source WHERE owner=$1 AND kind='conversation-inbox'
      AND data->>'threadId'=ANY($2::text[]) AND data->>'status' IN ('finished','interrupted')
      AND data->>'learningExcluded' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM records thread WHERE thread.owner=$1 AND thread.kind='threads'
        AND thread.id=source.data->>'threadId' AND thread.data->>'deletedAt' IS NOT NULL)
      ORDER BY data->>'createdAt' DESC,id DESC LIMIT 40`,
      [owner, threadIds],
    );
    return result.rows
      .map((row) => row.data as unknown as import("./conversation-inbox.ts").InboxMessage)
      .reverse();
  }
  async learningWatermark(owner: string) {
    const result = await this.db.query(
      `SELECT jsonb_build_object('id',id,'createdAt',data->>'createdAt') AS data FROM records
      WHERE owner=$1 AND kind='conversation-inbox' ORDER BY data->>'createdAt' DESC,id DESC LIMIT 1`,
      [owner],
    );
    return JSON.stringify(result.rows[0]?.data ?? null);
  }
  async learningConversationActive(owner: string) {
    const result = await this.db.query(
      `SELECT 1 FROM records WHERE owner=$1 AND kind='conversation-inbox'
      AND data->>'status' IN ('accepted','dispatching') LIMIT 1`,
      [owner],
    );
    return result.rows.length > 0;
  }
  /** Latest canonical transcript per thread, filtered in SQL; never load cumulative run copies. */
  async searchThreads(
    owner: string,
    query: string,
    limit: number,
    archived: boolean,
    time: { before?: string; after?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const result = await this.db.query(
      `WITH latest AS (
        SELECT DISTINCT ON (data->>'threadId') data FROM records WHERE owner=$1 AND kind='thread-runs' AND data->>'status'<>'running'
        ORDER BY data->>'threadId',data->>'createdAt' DESC,id DESC
      ), transcript AS (
        SELECT thread_id,data AS message,acquired_at AS date FROM thread_messages WHERE owner=$1
        UNION ALL SELECT latest.data->>'threadId',message,latest.data->>'createdAt' FROM latest,
          jsonb_array_elements(COALESCE(latest.data->'messages','[]'::jsonb)) message
          WHERE NOT EXISTS(SELECT 1 FROM thread_messages canonical WHERE canonical.owner=$1
            AND canonical.thread_id=latest.data->>'threadId' AND canonical.id=message->>'id')
      ), hits AS (
        SELECT thread.id AS thread_id,thread.data->>'name' AS name,message,date,
          CASE WHEN message->>'id' LIKE 'publication-%' THEN 2 WHEN message->>'role'='user' THEN 0 ELSE 1 END AS source_priority,
          ts_rank_cd(openmuse_search_vector(message->>'content'),openmuse_search_query($2)) AS score
        FROM transcript JOIN records thread ON thread.owner=$1 AND thread.kind='threads' AND thread.id=transcript.thread_id
        WHERE ($4::boolean OR COALESCE(thread.data->>'archived','false')='false') AND thread.data->>'deletedAt' IS NULL
          AND message->>'role' IN ('user','assistant') AND jsonb_typeof(message->'content')='string'
          AND (openmuse_search_vector(message->>'content') @@ openmuse_search_query($2) OR message->>'id'=$2)
          AND ($5::text IS NULL OR date<$5) AND ($6::text IS NULL OR date>$6)
      ), ranked AS (SELECT *, row_number() OVER (PARTITION BY thread_id ORDER BY source_priority,score DESC,date DESC,message->>'id') AS per_thread FROM hits)
      SELECT jsonb_build_object('threadId',thread_id,'name',name,'messageId',message->>'id','role',message->>'role',
        'excerpt',ts_headline('simple',message->>'content',openmuse_search_query($2),'StartSel="", StopSel="", MaxWords=70, MinWords=20'),
        'date',date,'source',CASE WHEN source_priority=2 THEN 'automation' ELSE 'conversation' END,'score',score) AS data
      FROM ranked WHERE per_thread<=3 ORDER BY source_priority,score DESC,date DESC,message->>'id' LIMIT $3`,
      [
        owner,
        query,
        Math.min(30, Math.max(1, limit)),
        archived,
        time.before ? new Date(time.before).toISOString() : null,
        time.after ? new Date(time.after).toISOString() : null,
      ],
    );
    return result.rows.map((row) => ({
      ...row.data,
      excerpt: String(row.data.excerpt ?? "").slice(0, 500),
    }));
  }
  async readThreadWindow(
    owner: string,
    threadId: string,
    messageId: string,
    before = 3,
    after = 5,
  ): Promise<ThreadWindow> {
    const result = await this.db.query(
      `WITH latest AS (SELECT data FROM records WHERE owner=$1 AND kind='thread-runs' AND data->>'threadId'=$2 AND data->>'status'<>'running'
         ORDER BY data->>'createdAt' DESC,id DESC LIMIT 1), transcript AS (
        SELECT position,data,acquired_at AS date FROM thread_messages WHERE owner=$1 AND thread_id=$2
        UNION ALL SELECT n AS position,message AS data,latest.data->>'createdAt' AS date FROM latest,
          jsonb_array_elements(COALESCE(latest.data->'messages','[]'::jsonb)) WITH ORDINALITY AS m(message,n)
          WHERE NOT EXISTS(SELECT 1 FROM thread_messages canonical WHERE canonical.owner=$1 AND canonical.thread_id=$2 AND canonical.id=message->>'id')
      ), anchor AS (SELECT position FROM transcript WHERE data->>'id'=$3), visible AS (
        SELECT data || jsonb_build_object('position',position,'date',date) AS data,position FROM transcript
        WHERE position BETWEEN (SELECT position FROM anchor)-$4 AND (SELECT position FROM anchor)+$5
      ), updates AS (
        SELECT data || jsonb_build_object('position',position,'date',date) AS data,position FROM transcript
        WHERE data->>'role'='user' AND position>(SELECT position FROM anchor) ORDER BY position DESC LIMIT 5
      ) SELECT jsonb_build_object(
        'messages',COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM visible),'[]'::jsonb),
        'recentUserUpdates',COALESCE((SELECT jsonb_agg(data ORDER BY position) FROM updates),'[]'::jsonb),
        'hasOlder',EXISTS(SELECT 1 FROM transcript WHERE position<(SELECT min(position) FROM visible)),
        'hasNewer',EXISTS(SELECT 1 FROM transcript WHERE position>(SELECT max(position) FROM visible))) AS data
      FROM records thread WHERE thread.owner=$1 AND thread.kind='threads' AND thread.id=$2 AND thread.data->>'deletedAt' IS NULL`,
      [
        owner,
        threadId,
        messageId,
        Math.min(10, Math.max(0, before)),
        Math.min(10, Math.max(0, after)),
      ],
    );
    return (
      (result.rows[0]?.data as unknown as ThreadWindow) ?? {
        messages: [],
        recentUserUpdates: [],
        hasOlder: false,
        hasNewer: false,
      }
    );
  }
  async insertThreadPublication(
    owner: string,
    threadId: string,
    token: string,
    run: { id: string } & Record<string, unknown>,
  ) {
    const result = await this.write(
      "SELECT openmuse_thread_publication($1,$2,$3,$4::jsonb) AS data",
      [owner, threadId, token, JSON.stringify(run)],
    );
    return (result.rows[0]?.data as unknown) === true;
  }
  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC",
      [kind],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }
  async claim<T>(owner: string, id: string, status: string, now: string): Promise<T | null> {
    const result = await this.write(
      `UPDATE records AS action SET data=jsonb_set(data,'{status}',$4::jsonb),updated_at=now()
       WHERE owner=$1 AND kind='actions' AND id=$2 AND data->>'status'='awaiting_review'
       AND (data->>'expiresAt')::timestamptz>$3::timestamptz
       AND ($4::jsonb <> '"executing"'::jsonb OR data->>'taskId' IS NULL OR EXISTS (
         SELECT 1 FROM records task WHERE task.owner=action.owner AND task.kind='tasks'
         AND task.id=action.data->>'taskId' AND task.data->>'status' IN ('running','waiting_approval')
       )) RETURNING data`,
      [owner, id, now, JSON.stringify(status)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async recoverInterruptedActions(): Promise<void> {
    await this.write(
      `UPDATE records SET data=data || '{"status":"outcome_unknown","error":"Server restarted during execution. Check the provider before creating another action."}'::jsonb WHERE kind='actions' AND data->>'status'='executing'`,
    );
  }
  async take<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown> = {},
  ): Promise<T | null> {
    const result = await this.write(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data",
      [owner, kind, id, JSON.stringify(expected)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  close(): Promise<void> {
    return this.db.close();
  }
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const result = await this.write(
      "UPDATE records SET data=jsonb_set(data,'{secret}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='credentials' AND (id='google' OR id LIKE 'google:%') AND data->>'connectionId'=$2 RETURNING data",
      [owner, connectionId, JSON.stringify(secret)],
    );
    return result.rows.length === 1;
  }
}

/** Idle clients can be disconnected by a database restart; without a listener pg's `error` event crashes the process. */
export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (error) => backgroundFailure("postgres pool", error));
  return pool;
}

export async function createStore(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Store> {
  let database: Database;
  if (options.databaseUrl) {
    const pool = createPool(options.databaseUrl);
    database = { query: async (sql, params) => pool.query(sql, params), close: () => pool.end() };
  } else {
    if (options.dataDir) await mkdir(dirname(options.dataDir), { recursive: true, mode: 0o700 });
    const embedded = new PGlite(options.dataDir);
    await embedded.waitReady;
    database = {
      query: (sql, params) => embedded.query<Row>(sql, params),
      close: () => embedded.close(),
    };
  }
  await database.query(
    "CREATE TABLE IF NOT EXISTS records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  await initializeDurableConversations((sql) => database.query(sql));
  await initializeThreadCompaction((sql) => database.query(sql));
  await initializeHistoryRetrieval((sql) => database.query(sql));
  await database.query(
    "CREATE INDEX IF NOT EXISTS procedure_telemetry_identity ON records(owner,kind,(data->>'procedureId'),(data->>'procedureVersion')) WHERE kind IN ('playbook-runs','procedure-outcomes','procedure-views')",
  );
  await database.query(
    "CREATE INDEX IF NOT EXISTS proactivity_event_due ON records(owner,(data->>'status'),(data->>'dueAt')) WHERE kind='proactivity-events'",
  );
  await database.query(
    "CREATE INDEX IF NOT EXISTS proactivity_event_source ON records(owner,(data->>'source'),(data->>'key'),(data->>'revision')) WHERE kind='proactivity-events'",
  );
  await initializeThreadLifecycle((sql) => database.query(sql));
  await initializeTaskRuntime((sql) => database.query(sql));
  await database.query(
    "CREATE INDEX IF NOT EXISTS task_scheduler_due ON records(kind,(data->>'status'),(data->>'nextRunAt')) WHERE kind='tasks'",
  );
  await database.query(`
    CREATE OR REPLACE FUNCTION openmuse_set_runtime_pause(target_paused boolean, expected_revision integer, changed_at text)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE current_state jsonb; current_revision integer; next_state jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-runtime-control',0));
      SELECT data INTO current_state FROM records
        WHERE owner='__runtime__' AND kind='runtime-pause' AND id='global';
      IF NOT FOUND THEN
        current_state := jsonb_build_object('paused',false,'revision',0,'changedAt','1970-01-01T00:00:00.000Z');
      END IF;
      IF (current_state->>'paused')::boolean=target_paused THEN RETURN current_state; END IF;
      current_revision := (current_state->>'revision')::integer;
      IF current_revision<>expected_revision THEN RETURN NULL; END IF;
      next_state := jsonb_build_object('paused',target_paused,'revision',current_revision+1,'changedAt',changed_at);
      INSERT INTO records(owner,kind,id,data) VALUES('__runtime__','runtime-pause','global',next_state)
        ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now();
      RETURN next_state;
    END $$`);
  await database.query(`
    CREATE OR REPLACE FUNCTION openmuse_claim_work_admission(task_id text, work_class text, root_task_id text, claimant text, now_at timestamptz, expires_at text)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE existing jsonb; paused_now boolean := false; occupied integer;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-runtime-control',0));
      SELECT (data->>'paused')::boolean INTO paused_now FROM records
        WHERE owner='__runtime__' AND kind='runtime-pause' AND id='global';
      -- Interactive desktop lifecycles observe/reset while paused. Their
      -- actual input still crosses the ordinary M4 global effect barrier.
      IF COALESCE(paused_now,false) AND work_class<>'interactive' THEN RETURN false; END IF;
      IF work_class='interactive' AND NOT EXISTS (
        SELECT 1 FROM records viewer JOIN records device ON device.owner='system'
          AND device.kind='device-sessions' AND device.id=viewer.data->>'deviceId'
        WHERE viewer.kind='desktop-viewer-sessions' AND viewer.id=task_id
          AND viewer.data->>'closed'='false' AND device.data->>'owner'=viewer.owner
          AND jsonb_typeof(device.data->'revokedAt')='null'
      ) THEN RETURN false; END IF;
      SELECT data INTO existing FROM records
        WHERE owner='__runtime__' AND kind='work-admissions' AND id=task_id;
      IF FOUND THEN
        -- Held work is the durable receipt for an external/background job.
        -- Any worker may reconcile the task, but only after its task lease CAS
        -- succeeds may it rebind the held admission to itself.
        IF existing->>'hold'='true' THEN RETURN true; END IF;
        IF existing->>'claimant'=claimant AND (existing->>'expiresAt')::timestamptz>now_at THEN
          UPDATE records SET data=data || jsonb_build_object('expiresAt',expires_at),updated_at=now()
            WHERE owner='__runtime__' AND kind='work-admissions' AND id=task_id;
          RETURN true;
        END IF;
        IF existing->>'hold'='true' OR (existing->>'expiresAt')::timestamptz>now_at THEN RETURN false; END IF;
      END IF;
      -- New admissions are closed during the operator's bounded drain lease.
      -- Existing held jobs above can still reconcile/finish without being killed.
      IF EXISTS (SELECT 1 FROM records WHERE owner='__runtime__' AND kind='deployment-maintenance'
        AND id='global' AND data->>'active'='true' AND (data->>'expiresAt')::timestamptz>now_at)
        THEN RETURN false; END IF;
      SELECT count(*) INTO occupied FROM records
        WHERE owner='__runtime__' AND kind='work-admissions'
          AND (data->>'hold'='true' OR (data->>'expiresAt')::timestamptz>now_at)
          AND COALESCE(data->>'workClass','background')=work_class
          AND id<>task_id;
      IF (occupied >= CASE WHEN work_class='interactive' THEN 2 ELSE 4 END) THEN RETURN false; END IF;
      INSERT INTO records(owner,kind,id,data) VALUES('__runtime__','work-admissions',task_id,
        jsonb_build_object('id',task_id,'workClass',work_class,'rootTaskId',root_task_id,
          'claimant',claimant,'hold',false,'expiresAt',expires_at))
        ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now();
      RETURN true;
    END $$`);
  await database.query(`
    CREATE OR REPLACE FUNCTION openmuse_deployment_maintenance(request_owner text, request_id text, operation text, now_at timestamptz, expires_at text)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE existing jsonb; value jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-runtime-control',0));
      SELECT data INTO existing FROM records WHERE owner='__runtime__' AND kind='deployment-maintenance' AND id='global' FOR UPDATE;
      IF operation='begin' THEN
        IF existing->>'active'='true' AND (existing->>'expiresAt')::timestamptz>now_at
          AND (existing->>'id'<>request_id OR existing->>'owner'<>request_owner) THEN RETURN NULL; END IF;
        value=jsonb_build_object('id',request_id,'owner',request_owner,'active',true,'expiresAt',expires_at);
      ELSE
        IF existing IS NULL OR existing->>'id'<>request_id OR existing->>'owner'<>request_owner THEN RETURN NULL; END IF;
        IF operation='renew' THEN
          IF existing->>'active'<>'true' OR (existing->>'expiresAt')::timestamptz<=now_at THEN RETURN NULL; END IF;
          value=existing || jsonb_build_object('expiresAt',expires_at);
        ELSIF operation='finish' THEN
          value=existing || jsonb_build_object('active',false,'expiresAt',now_at::text);
        ELSE RETURN NULL; END IF;
      END IF;
      INSERT INTO records(owner,kind,id,data) VALUES('__runtime__','deployment-maintenance','global',value)
        ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now();
      RETURN value;
    END $$`);
  await database.query(`
    CREATE OR REPLACE FUNCTION openmuse_acquire_resource_leases(request_owner text, task_id text, requests jsonb, now_at timestamptz, expires_at text)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE item jsonb; request_data jsonb; existing jsonb; current_fence bigint; next_fence bigint; output jsonb := '[]'::jsonb;
    BEGIN
      FOR item IN SELECT value FROM jsonb_array_elements(requests) ORDER BY value->>'key' LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-resource:' || (item->>'key'),0));
      END LOOP;
      FOR item IN SELECT value FROM jsonb_array_elements(requests) ORDER BY value->>'key' LOOP
        request_data := item - 'id';
        SELECT data INTO existing FROM records WHERE owner='__runtime__' AND kind='resource-leases'
          AND data->>'taskId'=task_id AND data->'request'->>'key'=item->>'key'
          AND (data->>'hold'='true' OR (data->>'expiresAt')::timestamptz>now_at) LIMIT 1;
        IF FOUND AND existing->'request'<>request_data THEN RETURN NULL; END IF;
        IF NOT FOUND AND EXISTS (
          SELECT 1 FROM records lease WHERE lease.owner='__runtime__' AND lease.kind='resource-leases'
            AND lease.data->'request'->>'key'=item->>'key'
            AND (lease.data->>'hold'='true' OR (lease.data->>'expiresAt')::timestamptz>now_at)
            AND lease.data->>'taskId'<>task_id
            AND ((request_data->>'mode'='exclusive') OR lease.data->'request'->>'mode'='exclusive')
        ) THEN RETURN NULL; END IF;
      END LOOP;
      FOR item IN SELECT value FROM jsonb_array_elements(requests) ORDER BY value->>'key' LOOP
        request_data := item - 'id';
        SELECT data INTO existing FROM records WHERE owner='__runtime__' AND kind='resource-leases'
          AND data->>'taskId'=task_id AND data->'request'->>'key'=item->>'key'
          AND (data->>'hold'='true' OR (data->>'expiresAt')::timestamptz>now_at) LIMIT 1;
        IF FOUND THEN
          IF existing->>'hold' IS DISTINCT FROM 'true' THEN
            UPDATE records SET data=jsonb_set(data,'{expiresAt}',to_jsonb(expires_at)),updated_at=now()
              WHERE owner='__runtime__' AND kind='resource-leases' AND id=existing->>'id';
          END IF;
          output := output || jsonb_build_array(jsonb_build_object('id',existing->>'id',
            'fence',(existing->>'fence')::bigint,'expiresAt',existing->>'expiresAt'));
          CONTINUE;
        END IF;
        SELECT COALESCE((data->>'fence')::bigint,0) INTO current_fence FROM records
          WHERE owner='__runtime__' AND kind='resource-fences' AND id=request_data->>'key';
        IF request_data->>'mode'='exclusive' THEN
          INSERT INTO records(owner,kind,id,data) VALUES('__runtime__','resource-fences',request_data->>'key',
            jsonb_build_object('id',request_data->>'key','fence',COALESCE(current_fence,0)+1))
            ON CONFLICT(owner,kind,id) DO UPDATE SET data=jsonb_build_object('id',excluded.id,
              'fence',COALESCE((records.data->>'fence')::bigint,0)+1),updated_at=now()
            RETURNING (data->>'fence')::bigint INTO next_fence;
        ELSE
          next_fence := COALESCE(current_fence,0);
        END IF;
        INSERT INTO records(owner,kind,id,data) VALUES('__runtime__','resource-leases',item->>'id',
          jsonb_build_object('id',item->>'id','owner',request_owner,'taskId',task_id,
            'request',request_data,'fence',next_fence,'expiresAt',expires_at,'hold',false));
        output := output || jsonb_build_array(jsonb_build_object('id',item->>'id',
          'fence',next_fence,'expiresAt',expires_at));
      END LOOP;
      RETURN output;
    END $$`);
  await database.query(`CREATE OR REPLACE FUNCTION openmuse_memory_fingerprint_valid(fact jsonb)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(jsonb_typeof(fact->'text')='string'
      AND fact->>'fingerprintVersion'='js-v1' AND fact->>'fingerprint' ~ '^[0-9a-f]{64}$'
      AND fact->>'fingerprintBinding'=encode(sha256(convert_to(
        (fact->>'fingerprint') || ':' || (fact->>'text'),'UTF8')),'hex'),false)
    $$`);
  // A future fingerprint-version migration must rebuild this predicate index.
  await database.query(`CREATE INDEX IF NOT EXISTS memory_fingerprint_repair ON records(owner,id)
    WHERE kind='memories' AND NOT openmuse_memory_fingerprint_valid(data)`);
  await database.query(`CREATE OR REPLACE FUNCTION openmuse_memory_mutation(fact_owner text, receipt_id text, binding_hash text, mutations jsonb, allow_restoration boolean)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE fact jsonb; previous jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || fact_owner,0));
      -- A committed request remains retryable even after a later forget.
      IF EXISTS(SELECT 1 FROM records WHERE owner=fact_owner AND kind='mutation-receipts' AND id=receipt_id) THEN
        RETURN openmuse_durable_mutation(fact_owner,receipt_id,binding_hash,mutations,'[]'::jsonb);
      END IF;
      fact := mutations->0->'value';
      SELECT data INTO previous FROM records WHERE owner=fact_owner AND kind='memories' AND id=fact->>'id' FOR UPDATE;
      IF fact->>'status'='active' AND NOT allow_restoration
        AND EXISTS(SELECT 1 FROM records WHERE owner=fact_owner AND kind='memory-suppressions' AND id=fact->>'fingerprint')
        AND NOT (COALESCE(previous->>'suppressionOverride','')=fact->>'fingerprint'
          AND openmuse_memory_fingerprint_valid(previous)
          AND previous->>'fingerprint'=fact->>'fingerprint') THEN
        RETURN jsonb_build_object('status','suppressed');
      END IF;
      RETURN openmuse_durable_mutation(fact_owner,receipt_id,binding_hash,mutations,'[]'::jsonb);
    END $$`);
  // Saves, corrections, forgetting and restoration use one transaction-scoped owner lock.
  await database.query(
    `CREATE OR REPLACE FUNCTION openmuse_save_memory(fact_owner text, fact jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
     DECLARE saved jsonb;
     BEGIN
       PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || fact_owner,0));
       -- A concurrent raw/older-writer edit may miss the byte-bound repair CAS.
       -- Do not deduplicate against an incomplete normalized view or create a second copy.
       IF EXISTS(SELECT 1 FROM records WHERE owner=fact_owner AND kind='memories'
         AND COALESCE(data->>'status','active')='active' AND NOT openmuse_memory_fingerprint_valid(data)) THEN
         RETURN jsonb_build_object('status','repair_pending');
       END IF;
       IF EXISTS(SELECT 1 FROM records WHERE owner=fact_owner AND kind='memory-suppressions' AND id=fact->>'fingerprint') THEN
         SELECT data INTO saved FROM records WHERE owner=fact_owner AND kind='memories'
           AND data->>'status'='active' AND openmuse_memory_fingerprint_valid(data)
           AND data->>'fingerprint'=fact->>'fingerprint'
           AND data->>'suppressionOverride'=fact->>'fingerprint' ORDER BY updated_at DESC,id LIMIT 1 FOR UPDATE;
         IF FOUND THEN RETURN saved; END IF;
         RETURN fact || '{"status":"forgotten"}'::jsonb;
       END IF;
       SELECT data INTO saved FROM records WHERE owner=fact_owner AND kind='memories'
         AND COALESCE(data->>'status','active')='active'
         AND openmuse_memory_fingerprint_valid(data) AND data->>'fingerprint'=fact->>'fingerprint'
         ORDER BY updated_at DESC,id LIMIT 1 FOR UPDATE;
       IF FOUND THEN RETURN saved; END IF;
       INSERT INTO records(owner,kind,id,data) VALUES(fact_owner,'memories',fact->>'id',fact);
       INSERT INTO records(owner,kind,id,data) VALUES(fact_owner,'memory-history',(fact->>'id') || ':1',
         jsonb_build_object('id',(fact->>'id') || ':1','entityId',fact->>'id','revision',1,'value',fact,'action','save','changedAt',fact->>'createdAt'));
       RETURN fact;
     END $$`,
  );
  await database.query(
    "CREATE INDEX IF NOT EXISTS memory_current_fingerprint ON records(owner,(data->>'fingerprint')) WHERE kind='memories' AND COALESCE(data->>'status','active')='active'",
  );
  await database.query("DROP INDEX IF EXISTS memory_current_text");
  await database.query(
    "CREATE INDEX IF NOT EXISTS revision_history_entity ON records(owner,kind,(data->>'entityId'),((data->>'revision')::integer) DESC) WHERE kind IN ('memory-history','profile-history')",
  );
  await database.query(
    "CREATE INDEX IF NOT EXISTS records_thread_runs ON records(owner,(data->>'threadId'),(data->>'createdAt'),id) WHERE kind='thread-runs'",
  );
  await database.query(
    "CREATE TABLE IF NOT EXISTS external_action_log(owner text NOT NULL,id text NOT NULL,time timestamptz NOT NULL,data jsonb NOT NULL,PRIMARY KEY(owner,id))",
  );
  await database.query(
    "CREATE INDEX IF NOT EXISTS external_action_log_owner_time ON external_action_log(owner,time DESC,id DESC)",
  );
  await database.query(
    `CREATE OR REPLACE FUNCTION reject_action_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'External action log is append-only'; END $$`,
  );
  await database.query(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='external_action_log_immutable' AND tgrelid='external_action_log'::regclass) THEN CREATE TRIGGER external_action_log_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON external_action_log FOR EACH STATEMENT EXECUTE FUNCTION reject_action_log_mutation(); END IF; END $$",
  );
  return new Store(database);
}
