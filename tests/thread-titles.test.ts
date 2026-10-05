import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { createStore } from "../apps/server/src/db.ts";
import { LocalThreads } from "../apps/server/src/threads.ts";

test("saved untitled conversations receive distinct titles and manual names survive", async () => {
  const db = await createStore();
  const threads = new LocalThreads(db);
  try {
    for (const [id, content] of [
      ["elections", "Como estão as eleições do Brasil? Como está a apuração?"],
      ["makeup", "Pesquisa pra mim promoções de maquiagem"],
    ]) {
      await threads.ensure("owner", id);
      await db.put("owner", "thread-runs", {
        id: `${id}-run`,
        threadId: id,
        runId: `${id}-run`,
        createdAt: new Date().toISOString(),
        status: "finished",
        state: {},
        messages: [{ id: `${id}-user`, role: "user", content }],
        events: [{ type: EventType.RUN_FINISHED, threadId: id, runId: `${id}-run` }],
      });
    }
    await threads.handle(
      new Request("http://local/api/copilotkit/threads/makeup", {
        method: "PATCH",
        body: JSON.stringify({ agentId: "default", name: "Meu nome escolhido" }),
      }),
      "owner",
    );
    const response = await threads.handle(
      new Request("http://local/api/copilotkit/threads?agentId=default"),
      "owner",
    );
    const { threads: saved } = await response!.json();
    assert.match(
      saved.find((row: { id: string }) => row.id === "elections").name,
      /eleições do Brasil/,
    );
    assert.equal(
      saved.find((row: { id: string }) => row.id === "makeup").name,
      "Meu nome escolhido",
    );
    assert.equal(
      (await db.get<{ name: string }>("owner", "threads", "elections"))?.name,
      saved.find((row: { id: string }) => row.id === "elections").name,
    );
  } finally {
    await threads.close();
    await db.close();
  }
});
