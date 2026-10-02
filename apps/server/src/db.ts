import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { AgentMemory, AgentNotification } from "../../../packages/domain/src/agent.ts";
import type { ActionLogEntry } from "../../../packages/domain/src/index.ts";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown> };
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  close: () => Promise<void>;
}

export class Store {
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
      `INSERT INTO records(owner,kind,id,data) SELECT $1,'push-deliveries',$2,$3::jsonb
       WHERE EXISTS (SELECT 1 FROM records WHERE owner=$1 AND kind='push-devices' AND id=$4
         AND data->>'token'=$5 AND data->>'platform'=$6 AND data->>'registrationId' IS NOT DISTINCT FROM $7::text)
       ON CONFLICT DO NOTHING RETURNING data`,
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
    const result = await this.write(
      `UPDATE records AS run SET data=jsonb_set(data,'{events}',COALESCE(data->'events','[]'::jsonb) || $3::jsonb),updated_at=now()
       WHERE owner=$1 AND kind='thread-runs' AND id=$2 AND data->>'status'='running' AND EXISTS (
         SELECT 1 FROM records thread WHERE thread.owner=run.owner AND thread.kind='threads' AND thread.id=run.data->>'threadId'
         AND thread.data->>'runToken'=run.id AND (thread.data->>'leaseUntil')::timestamptz>clock_timestamp()
       ) RETURNING data`,
      [owner, id, JSON.stringify([event])],
    );
    if (!result.rows.length) throw new Error("Conversation run lease expired");
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
      `WITH recovered AS (
         UPDATE records AS run SET data=data || $5::jsonb,updated_at=now()
         WHERE owner=$1 AND kind='thread-runs' AND id=$3 AND data->>'threadId'=$2
         AND data->>'status'='running' AND data->'events'=$4::jsonb AND NOT EXISTS (
           SELECT 1 FROM records thread WHERE thread.owner=run.owner AND thread.kind='threads' AND thread.id=$2
           AND thread.data->>'runToken'=run.id AND (thread.data->>'leaseUntil')::timestamptz>clock_timestamp()
         ) RETURNING data
       ), released AS (
         UPDATE records SET data=data || '{"runToken":null,"leaseUntil":null}'::jsonb,updated_at=now()
         WHERE owner=$1 AND kind='threads' AND id=$2 AND data->>'runToken'=$3 AND EXISTS (SELECT 1 FROM recovered) RETURNING data
       ) SELECT data FROM recovered`,
      [owner, threadId, token, JSON.stringify(expectedEvents), JSON.stringify(patch)],
    );
    return result.rows.length === 1;
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
      `WITH saved AS (
      INSERT INTO records(owner,kind,id,data) SELECT $1,'thread-runs',$4,$5::jsonb
      WHERE EXISTS(SELECT 1 FROM records WHERE owner=$1 AND kind='threads' AND id=$2
        AND data->>'runToken'=$3 AND (data->>'leaseUntil')::timestamptz>clock_timestamp())
      ON CONFLICT DO NOTHING RETURNING data
    ), released AS (
      UPDATE records SET data=data || '{"runToken":null,"leaseUntil":null}'::jsonb,updated_at=now()
      WHERE owner=$1 AND kind='threads' AND id=$2 AND data->>'runToken'=$3 AND EXISTS(SELECT 1 FROM saved) RETURNING data
    ) SELECT data FROM saved`,
      [owner, threadId, token, run.id, JSON.stringify(run)],
    );
    return result.rows.length === 1;
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
