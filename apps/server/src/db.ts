import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { AgentMemory, AgentNotification } from "../../../packages/domain/src/agent.ts";
import type { ActionLogEntry } from "../../../packages/domain/src/index.ts";
import type {
  ConversationEvent,
  ResourceLease,
  ResourceRequest,
  RuntimePauseState,
  WorkClass,
} from "../../../packages/domain/src/runtime.ts";
import { initializeDurableConversations } from "./durable-schema.ts";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown> };
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  close: () => Promise<void>;
}

export class Store {
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
  ) {
    const result = await this.write(
      "SELECT openmuse_durable_mutation($1,$2,$3,$4::jsonb,$5::jsonb) AS data",
      [owner, receiptId, bindingHash, JSON.stringify(mutations), JSON.stringify(events)],
    );
    return result.rows[0].data as unknown as {
      status: "applied" | "duplicate" | "binding_conflict" | "revision_conflict";
      values: T[];
      events: ConversationEvent[];
    };
  }
  async conversationEvents(owner: string, threadId: string, cursor: number, limit = 500) {
    const result = await this.db.query(
      `SELECT jsonb_build_object(
      'events',COALESCE((SELECT jsonb_agg(data ORDER BY seq) FROM (SELECT seq,data FROM conversation_events WHERE owner=$1 AND thread_id=$2 AND seq>$3 ORDER BY seq LIMIT $4) tail),'[]'::jsonb),
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
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.write("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [owner, kind, id]);
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
            ((COALESCE(data->'state','{}'::jsonb) || $4::jsonb->'state') ||
              jsonb_strip_nulls(jsonb_build_object(
                'desiredRevision',data->'state'->'desiredRevision',
                'mailboxSeq',data->'state'->'mailboxSeq')))
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
       WHERE owner=$1 AND kind='threads' AND id=$2 AND (data->>'runToken' IS NULL OR (data->>'leaseUntil')::timestamptz<=clock_timestamp()) RETURNING data`,
      [owner, id, runToken, leaseMs],
    );
    return result.rows.length === 1;
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
  ): Promise<{ runs: T[]; activeRunToken: string | null }> {
    const result = await this.db.query(
      `WITH ordered AS (
         SELECT run.id,run.data,row_number() OVER (ORDER BY run.data->>'createdAt' DESC,run.id DESC) AS position
         FROM records run WHERE run.owner=$1 AND run.kind='thread-runs' AND run.data->>'threadId'=$2
       ), projected AS (
         SELECT id,CASE WHEN data->>'status'='running' THEN data ELSE
           (CASE WHEN position=1 THEN data - 'inputMessages' - 'initialState'
             ELSE data - 'messages' - 'inputMessages' - 'state' - 'initialState' END)
           || jsonb_build_object('events',COALESCE((SELECT jsonb_agg(
             CASE WHEN event->>'type'='RUN_STARTED' THEN event - 'input' ELSE event END ORDER BY n)
             FROM jsonb_array_elements(COALESCE(data->'events','[]'::jsonb)) WITH ORDINALITY AS e(event,n)), '[]'::jsonb)) END AS data
         FROM ordered
       ) SELECT jsonb_build_object(
         'runs',COALESCE((SELECT jsonb_agg(run.data ORDER BY run.data->>'createdAt',run.id) FROM projected run),'[]'::jsonb),
         'activeRunToken',CASE WHEN (data->>'leaseUntil')::timestamptz>clock_timestamp() THEN data->>'runToken' ELSE NULL END
       ) AS data FROM records WHERE owner=$1 AND kind='threads' AND id=$2`,
      [owner, id],
    );
    return (
      (result.rows[0]?.data as { runs: T[]; activeRunToken: string | null } | undefined) ?? {
        runs: [],
        activeRunToken: null,
      }
    );
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
  async findMemories(owner: string, query: string, limit: number): Promise<AgentMemory[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind='memories' AND strpos(lower(data->>'text'),lower($2))>0 ORDER BY updated_at DESC,id LIMIT $3",
      [owner, query, Math.min(40, limit)],
    );
    return result.rows.map((row) => row.data as unknown as AgentMemory);
  }
  /** Fact IDs survive edits; deduplication compares the current text atomically. */
  async saveMemory(owner: string, value: AgentMemory): Promise<AgentMemory> {
    const result = await this.write("SELECT openmuse_save_memory($1,$2::jsonb) AS data", [
      owner,
      JSON.stringify(value),
    ]);
    return result.rows[0].data as unknown as AgentMemory;
  }
  /** Latest canonical transcript per thread, filtered in SQL; never load cumulative run copies. */
  async searchThreads(owner: string, query: string, limit: number, archived: boolean) {
    const result = await this.db.query(
      `WITH latest AS (
      SELECT DISTINCT ON (data->>'threadId') data FROM records
      WHERE owner=$1 AND kind='thread-runs' AND data->>'status'<>'running'
      ORDER BY data->>'threadId',data->>'createdAt' DESC,id DESC
    ) SELECT jsonb_build_object('threadId',thread.id,'name',thread.data->>'name',
      'messageId',message->>'id','role',message->>'role','excerpt',substring(message->>'content' FROM greatest(1,strpos(lower(message->>'content'),lower($2))-80) FOR 500),'date',latest.data->>'createdAt') AS data
      FROM latest JOIN records thread ON thread.owner=$1 AND thread.kind='threads' AND thread.id=latest.data->>'threadId',
      jsonb_array_elements(COALESCE(latest.data->'messages','[]'::jsonb)) message
      WHERE ($4::boolean OR thread.data->>'archived'='false') AND message->>'role' IN ('user','assistant')
      AND jsonb_typeof(message->'content')='string' AND strpos(lower(message->>'content'),lower($2))>0
      ORDER BY latest.data->>'createdAt' DESC,message->>'id' LIMIT $3`,
      [owner, query, Math.min(30, Math.max(1, limit)), archived],
    );
    return result.rows.map((row) => row.data);
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
      "UPDATE records SET data=jsonb_set(data,'{secret}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='credentials' AND id='google' AND data->>'connectionId'=$2 RETURNING data",
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
      IF COALESCE(paused_now,false) THEN RETURN false; END IF;
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
      SELECT count(*) INTO occupied FROM records
        WHERE owner='__runtime__' AND kind='work-admissions'
          AND (data->>'hold'='true' OR (data->>'expiresAt')::timestamptz>now_at)
          AND id<>task_id;
      IF occupied>=4 THEN RETURN false; END IF;
      INSERT INTO records(owner,kind,id,data) VALUES('__runtime__','work-admissions',task_id,
        jsonb_build_object('id',task_id,'workClass',work_class,'rootTaskId',root_task_id,
          'claimant',claimant,'hold',false,'expiresAt',expires_at))
        ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now();
      RETURN true;
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
  // A transaction-scoped owner lock serializes concurrent saves. Locking the
  // matching row also makes a concurrent edit/forget observe a consistent fact.
  await database.query(
    `CREATE OR REPLACE FUNCTION openmuse_save_memory(fact_owner text, fact jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
     DECLARE saved jsonb;
     BEGIN
       PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-memory:' || fact_owner,0));
       SELECT data INTO saved FROM records WHERE owner=fact_owner AND kind='memories'
         AND lower(normalize(data->>'text',NFKC))=lower(normalize(fact->>'text',NFKC))
         ORDER BY updated_at DESC,id LIMIT 1 FOR UPDATE;
       IF FOUND THEN RETURN saved; END IF;
       INSERT INTO records(owner,kind,id,data) VALUES(fact_owner,'memories',fact->>'id',fact);
       RETURN fact;
     END $$`,
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
