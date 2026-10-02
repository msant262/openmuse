import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { ActionLogEntry } from "../../../packages/domain/src/index.ts";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown> };
interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  close: () => Promise<void>;
}

export class Store {
  constructor(private readonly db: Database) {}
  async appendActionLog(owner: string, entry: ActionLogEntry): Promise<void> {
    await this.db.query(
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
  async unfinishedActionLog(): Promise<{ owner: string; value: ActionLogEntry }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',start.owner,'value',start.data) AS data FROM external_action_log start WHERE start.data->>'result'='started' AND NOT EXISTS (SELECT 1 FROM external_action_log done WHERE done.owner=start.owner AND done.data->>'operationId'=start.data->>'operationId' AND done.data->>'result'<>'started') ORDER BY start.time LIMIT 200",
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
  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return value;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [
      owner,
      kind,
      id,
    ]);
  }
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.db.query(
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
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  /** Atomic append avoids losing streamed events to another database connection. */
  async appendRecordEvent(owner: string, id: string, event: unknown): Promise<void> {
    const result = await this.db.query(
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
    const result = await this.db.query(
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
    const result = await this.db.query(
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
      `SELECT jsonb_build_object(
         'runs',COALESCE((SELECT jsonb_agg(run.data ORDER BY run.data->>'createdAt',run.id)
           FROM records run WHERE run.owner=$1 AND run.kind='thread-runs' AND run.data->>'threadId'=$2),'[]'::jsonb),
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
    const result = await this.db.query(
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
    const result = await this.db.query(
      `UPDATE records SET data=data || '{"runToken":null,"leaseUntil":null}'::jsonb
       WHERE owner=$1 AND kind='threads' AND id=$2 AND data->>'runToken'=$3 AND (data->>'leaseUntil')::timestamptz<=clock_timestamp() RETURNING data`,
      [owner, id, token],
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
    const result = await this.db.query(
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
    await this.db.query(
      `UPDATE records SET data=data || '{"status":"outcome_unknown","error":"Server restarted during execution. Check the provider before creating another action."}'::jsonb WHERE kind='actions' AND data->>'status'='executing'`,
    );
  }
  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  close(): Promise<void> {
    return this.db.close();
  }
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const result = await this.db.query(
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
