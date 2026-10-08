import { AbstractAgent, type BaseEvent, EventType, type Message } from "@ag-ui/client";
import { of } from "rxjs";
import { z } from "zod";
import type { Store } from "./db.ts";

type ReplayableRun = {
  threadId: string;
  runId: string;
  events: BaseEvent[];
  inputMessages?: Message[];
  initialState?: Record<string, unknown>;
};
/** The same durable event projection serves full history, recovery and bounded pages. */
export async function replayThreadSnapshot(run: ReplayableRun, events = run.events) {
  // Merge only consecutive token/argument deltas. The generic AG-UI compactor
  // folds STATE_DELTA against an empty state, losing this run's initialState.
  // Preserve state, metadata and protocol ordering exactly as persisted.
  const compacted: BaseEvent[] = [];
  for (const event of events) {
    const previous = compacted.at(-1);
    if (
      previous &&
      !previous.metadata &&
      !event.metadata &&
      previous.type === event.type &&
      ((event.type === EventType.TEXT_MESSAGE_CONTENT &&
        "messageId" in previous &&
        "messageId" in event &&
        previous.messageId === event.messageId) ||
        (event.type === EventType.TOOL_CALL_ARGS &&
          "toolCallId" in previous &&
          "toolCallId" in event &&
          previous.toolCallId === event.toolCallId)) &&
      "delta" in previous &&
      typeof previous.delta === "string" &&
      "delta" in event &&
      typeof event.delta === "string"
    ) {
      compacted[compacted.length - 1] = {
        ...previous,
        delta: previous.delta + event.delta,
      } as BaseEvent;
    } else {
      compacted.push(event);
    }
  }
  class ReplayAgent extends AbstractAgent {
    run() {
      return of(...compacted);
    }
  }
  const reader = new ReplayAgent();
  reader.setMessages(run.inputMessages ?? []);
  reader.setState(run.initialState ?? {});
  reader.threadId = run.threadId;
  try {
    await reader.runAgent({ runId: run.runId });
  } catch {
    /* RUN_ERROR still leaves the applied partial snapshot. */
  }
  return { messages: reader.messages, state: reader.state };
}

/** Rich events and M2 inbox receipts are retained; only redundant finished-run copies are removed. */
export class ThreadCompaction {
  constructor(private readonly db: Store) {}
  migrate(owner: string, threadId: string) {
    return this.db.compactThread(owner, threadId);
  }
  resume(owner: string, threadId: string) {
    return this.migrate(owner, threadId);
  }
  async messages(
    owner: string,
    threadId: string,
    options: { cursor?: string; limit?: number; direction?: "forward" | "backward" } = {},
  ) {
    await this.resume(owner, threadId);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(options.limit ?? 50);
    const latest = await this.db.latestUncompactedThreadRun<
      ReplayableRun & { status: string; messages: Message[] }
    >(owner, threadId);
    if (!latest) return this.db.threadMessagePage(owner, threadId, { ...options, limit });
    // A running checkpoint stays intact. Its durable inputs/events overlay the last compacted
    // transcript, including receipts not yet copied to the checkpoint's messages field.
    const current =
      latest.status === "running" ? (await replayThreadSnapshot(latest)).messages : latest.messages;
    const position = options.cursor
      ? current.findIndex((message) => message.id === options.cursor)
      : -1;
    if (options.direction === "backward") {
      const end = options.cursor && position >= 0 ? position : current.length;
      const start = Math.max(0, end - limit);
      const messages = current.slice(start, end);
      return {
        messages,
        snapshotRequired: Boolean(options.cursor && position < 0),
        ...(start > 0 ? { previousCursor: messages[0]?.id } : {}),
      };
    }
    const messages = current.slice(position + 1, position + 1 + limit);
    return {
      messages,
      snapshotRequired: Boolean(options.cursor && position < 0),
      ...(position + 1 + limit < current.length ? { nextCursor: messages.at(-1)?.id } : {}),
    };
  }
}

export async function initializeThreadCompaction(query: (sql: string) => Promise<unknown>) {
  await query(`CREATE TABLE IF NOT EXISTS thread_messages (
    owner text NOT NULL, thread_id text NOT NULL, position bigint NOT NULL, id text NOT NULL,
    data jsonb NOT NULL, acquired_at text NOT NULL,
    PRIMARY KEY(owner,thread_id,id), UNIQUE(owner,thread_id,position)
  )`);
  await query(
    `CREATE INDEX IF NOT EXISTS thread_message_search ON thread_messages USING gin(to_tsvector('simple',COALESCE(data->>'content','')))`,
  );
  await query(`CREATE OR REPLACE FUNCTION openmuse_compact_thread(event_owner text, event_thread text)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE latest jsonb; item jsonb; n bigint;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('openmuse-durable:' || event_owner,0));
      PERFORM 1 FROM records WHERE owner=event_owner AND kind='threads' AND id=event_thread FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
      SELECT data INTO latest FROM records WHERE owner=event_owner AND kind='thread-runs' AND data->>'threadId'=event_thread
        ORDER BY data->>'createdAt' DESC,id DESC LIMIT 1 FOR UPDATE;
      IF NOT FOUND OR latest->>'status'='running' THEN RETURN false; END IF;
      IF NOT (latest ? 'messages') THEN RETURN true; END IF;
      n := 0;
      FOR item IN SELECT value FROM jsonb_array_elements(latest->'messages') LOOP
        n := n+1;
        INSERT INTO thread_messages(owner,thread_id,position,id,data,acquired_at)
          VALUES(event_owner,event_thread,n,item->>'id',item,latest->>'createdAt')
          ON CONFLICT(owner,thread_id,id) DO UPDATE SET data=excluded.data;
      END LOOP;
      UPDATE records run SET data=(data - 'messages' - 'inputMessages' - 'initialState') || jsonb_build_object(
        'contextStorageVersion',1,'events',COALESCE((SELECT jsonb_agg(CASE WHEN event->>'type'='RUN_STARTED' THEN event - 'input' ELSE event END ORDER BY ord)
          FROM jsonb_array_elements(COALESCE(run.data->'events','[]'::jsonb)) WITH ORDINALITY AS e(event,ord)),'[]'::jsonb))
        WHERE owner=event_owner AND kind='thread-runs' AND data->>'threadId'=event_thread AND data->>'status'<>'running';
      RETURN true;
    END $$`);
}

export type ThreadMessagePage = {
  messages: Message[];
  nextCursor?: string;
  previousCursor?: string;
  snapshotRequired: boolean;
};
