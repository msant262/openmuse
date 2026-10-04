import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@ag-ui/core";
import { createStore } from "../apps/server/src/db.ts";
import { MemoryService } from "../apps/server/src/memory.ts";
import { personalTools } from "../apps/server/src/personal-tools.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function transcript(
  db: Awaited<ReturnType<typeof createStore>>,
  owner: string,
  id: string,
  messages: Message[],
  archived = false,
) {
  await db.put(owner, "threads", { id, name: id, archived });
  await db.put(owner, "thread-runs", {
    id: `run-${id}`,
    threadId: id,
    runId: id,
    createdAt: "2026-10-04T12:00:00Z",
    status: "finished",
    messages,
    events: [],
    state: {},
  });
}

test("history retrieves reordered accented words and ranks human conversation above repeated automation", async () => {
  const db = await createStore();
  try {
    await transcript(db, "owner", "trip", [
      {
        id: "trip-user",
        role: "user",
        content: "Na viagem para Lisboa prefiro hotéis tranquilos.",
      },
    ]);
    await transcript(
      db,
      "owner",
      "automation",
      Array.from({ length: 35 }, (_, i) => ({
        id: `publication-${i}`,
        role: "assistant",
        content: "Lisboa hotéis tranquilos. ".repeat(10),
      })),
    );
    await transcript(db, "foreign", "private", [
      { id: "private-user", role: "user", content: "PRIVATE hotéis tranquilos Lisboa" },
    ]);
    await transcript(
      db,
      "owner",
      "archived",
      [{ id: "archived-user", role: "user", content: "ARCHIVED hotéis tranquilos Lisboa" }],
      true,
    );
    for (const canonical of [false, true]) {
      if (canonical)
        for (const id of ["trip", "automation", "archived"]) await db.compactThread("owner", id);
      const matches = await db.searchThreads("owner", "tranquilos hoteis Lisboa", 10, false);
      assert.equal(matches[0]?.messageId, "trip-user");
      assert.ok(matches.length > 1, "automation remains searchable but demoted");
      assert.ok(matches.length <= 4, "one repetitive thread cannot monopolize the page");
      assert.doesNotMatch(JSON.stringify(matches), /PRIVATE|ARCHIVED/);
    }
  } finally {
    await db.close();
  }
});

test("history source reads include nearby messages, later user corrections and bounded long-message pages", async (t) => {
  const server = await taskRuntime(t);
  const messages: Message[] = [
    { id: "trip", role: "user", content: "Vou viajar para Lisboa." },
    ...Array.from(
      { length: 24 },
      (_, i): Message => ({
        id: `research-${i}`,
        role: "assistant",
        content: `Hotel observation ${i}`,
      }),
    ),
    { id: "cancel", role: "user", content: "Cancelei essa viagem, não vou mais." },
    {
      id: "long",
      role: "user",
      content: "Primeiro trecho. ".repeat(500) + "FINAL_ORIGINAL_MESSAGE",
    },
  ];
  await transcript(server.db, "owner", "trip-chat", messages);
  const tool = personalTools(server.agent, "owner", "chat:history").find(
    (t) => t.name === "read_past_thread",
  );
  assert.ok(tool, "a search hit must have a source-reading tool");
  const read = (input: unknown) =>
    tool.execute!(input as never) as Promise<{
      messages: { id: string; content: string; nextOffset?: number }[];
      recentUserUpdates: { id: string; content: string }[];
      olderCursor?: string;
      newerCursor?: string;
    }>;
  const result = await read({ threadId: "trip-chat", messageId: "trip", before: 0, after: 2 });
  assert.deepEqual(
    result.messages.map((m) => m.id),
    ["trip", "research-0", "research-1"],
  );
  assert.ok(
    result.recentUserUpdates.some((m) => m.id === "cancel" && m.content.includes("Cancelei")),
  );
  assert.equal(result.newerCursor, "research-1");
  let offset = 0;
  let content = "";
  do {
    const page = await read({
      threadId: "trip-chat",
      messageId: "long",
      before: 0,
      after: 0,
      offset,
    });
    const item = page.messages[0];
    assert.ok(item.content.length <= 2000);
    content += item.content;
    offset = item.nextOffset ?? 0;
  } while (offset);
  assert.equal(content, messages.at(-1)!.content);
  await assert.rejects(read({ threadId: "trip-chat", messageId: "unknown" }), /not found/i);
  const foreign = personalTools(server.agent, "foreign", "chat:history").find(
    (t) => t.name === "read_past_thread",
  )!;
  await assert.rejects(
    foreign.execute!({ threadId: "trip-chat", messageId: "trip" } as never) as Promise<unknown>,
    /not found/i,
  );
});

test("ranked memory recall filters forgotten and expired facts before ranking and pages without duplicates", async () => {
  const db = await createStore();
  try {
    const memory = new MemoryService(db, () => Date.parse("2026-10-04T12:00:00Z"));
    const relevant = await memory.save("owner", "Prefere hotéis tranquilos perto de parques.");
    await memory.save("owner", "Viagem antiga com hotéis tranquilos.", "user", {
      validUntil: "2026-10-01T00:00:00Z",
    });
    const forgotten = await memory.save("owner", "Esquecer: hotéis tranquilos com piscina.");
    await memory.forget("owner", forgotten.id);
    await memory.save("other", "PRIVATE hotéis tranquilos.");
    const second = await memory.save(
      "owner",
      "Para descansar, procura hotéis pequenos e tranquilos.",
    );
    const first = await memory.page("owner", { query: "tranquilos hoteis", limit: 1 });
    assert.equal(first.entries.length, 1);
    assert.ok(first.nextCursor);
    const next = await memory.page("owner", {
      query: "tranquilos hoteis",
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(next.entries.length, 1);
    assert.notEqual(first.entries[0].id, next.entries[0].id);
    assert.deepEqual(
      new Set([...first.entries, ...next.entries].map((m) => m.id)),
      new Set([relevant.id, second.id]),
    );
    assert.doesNotMatch(
      JSON.stringify(await memory.recall("owner", "hoteis tranquilos")),
      /PRIVATE|Esquecer|antiga/,
    );
  } finally {
    await db.close();
  }
});
