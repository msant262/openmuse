import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { ResourceBusyError, ResourceLeases } from "../apps/server/src/engine/resource-leases.ts";
import { BrowserSearchBackend } from "../apps/server/src/search.ts";
import { searchTools } from "../apps/server/src/search-tools.ts";
import { searchResultSchema } from "../packages/domain/src/search.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

function searchResult(id: string, query: string) {
  return {
    query,
    status: "ok",
    sources: [
      {
        title: "Primary fixture",
        url: "https://example.org/source",
        snippet: "Index evidence",
        date: "2026-10-03",
      },
    ],
    observedAt: new Date().toISOString(),
    truncated: false,
    provenance: {
      backend: "browser",
      provider: "duckduckgo-html",
      searchUrl: "https://html.duckduckgo.com/html/?q=fixture",
      sessionId: id,
      fullPagesRead: false,
    },
  };
}
test("search backend and tool reuse profile authority, return typed failure and cancel before dispatch", async (t) => {
  let id = "",
    fail = false;
  const paths: string[] = [];
  const fixture = await browserFixture(t, (path, body) => {
    paths.push(path);
    if (path === "/sessions") id = String(body.id);
    if (path.endsWith("/search"))
      return fail
        ? { status: 502, data: { error: { code: "SEARCH_UNAVAILABLE", message: "Challenge" } } }
        : { data: searchResult(id, String(body.query)) };
    return {
      data: {
        id,
        title: "Profile",
        url: "https://example.org/",
        status: "active",
        control: "agent",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  const backend = new BrowserSearchBackend(fixture.service);
  const tool = searchTools(backend, "owner")[0];
  const result = await tool.execute!({ query: "fixture", limit: 2 });
  assert.equal((result as { status: string }).status, "ok");
  const leases = new ResourceLeases(fixture.db);
  const blocked = await leases.acquire("owner", "busy", [
    { key: `browser-profile:openmuse-server:${id}`, mode: "exclusive", units: 1 },
  ]);
  assert.ok(blocked);
  await assert.rejects(
    backend.search({ query: "fixture", limit: 2 }, { owner: "owner", taskId: "other" }),
    ResourceBusyError,
  );
  await Promise.all(blocked.map((lease) => leases.release(lease)));
  fail = true;
  assert.equal(
    (await backend.search({ query: "fixture", limit: 2 }, { owner: "owner" })).code,
    "SEARCH_UNAVAILABLE",
  );
  const controller = new AbortController();
  controller.abort();
  const count = paths.length;
  assert.equal(
    (
      await backend.search(
        { query: "fixture", limit: 2 },
        { owner: "owner", signal: controller.signal },
      )
    ).status,
    "cancelled",
  );
  assert.equal(paths.length, count);
  assert.equal((await fixture.db.list("owner", "browsers")).length, 1);
});
test("chat delegates search promptly and the worker journals HTTP reads without treating an index as verified evidence", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "delegate_task", arguments: { kind: "agent", prompt: "Find fixture sources" } }
      : index === 2
        ? { name: "search_web", arguments: { query: "fixture sources", limit: 3 } }
        : index === 3
          ? {
              name: "finish_task",
              arguments: { summary: "Discovered a source; its page has not been read." },
            }
          : undefined,
  );
  let id = "";
  const paths: string[] = [];
  const fixture = await browserFixture(t, (path, body) => {
    paths.push(path);
    if (path === "/sessions") id = String(body.id);
    if (path.endsWith("/search")) return { data: searchResult(id, String(body.query)) };
    return {
      data: {
        id,
        title: "Profile",
        url: "https://example.org/",
        status: "active",
        control: "agent",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  const config = {
    ...fixture.config,
    model: "openai/fixture",
    agentBackend: "model",
    modelProviders: richChatFixtureProviders(fixture.config.dataDir),
  } as const;
  const server = await createApp(fixture.db, config);
  t.after(() => server.agent.stop());
  await fixture.db.put("owner", "threads", { id: "search-chat" });
  const document = t.mock.method(server.agent.web, "document", async (url: string) => ({
    url,
    contentType: url.includes("bing.com") ? "text/xml" : "text/html",
    body: url.includes("bing.com")
      ? "<rss><channel><item><title>Primary fixture</title><link>https://example.org/source</link><description>Index evidence</description></item></channel></rss>"
      : '<div class="result"><a class="result__a" href="https://example.org/source">Primary fixture</a><div class="result__snippet">Index evidence</div></div>',
  }));
  t.mock.method(server.agent.web, "validate", async (url: string) => ({
    url: new URL(url),
    address: "93.184.216.34",
    family: 4,
  }));
  const input: RunAgentInput = {
    threadId: "search-chat",
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: "Find fixture sources" }],
    tools: [],
    context: [],
    state: {},
  };
  const events = await lastValueFrom(
    new ConversationAgent(config, server.agent, "owner").run(input).pipe(toArray()),
  );
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  const receipt = JSON.parse(String(result.content));
  assert.equal(receipt.status, "queued");
  assert.equal(receipt.delegated, true);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(requests.length, 2, "chat completes after handing off the search");
  assert.equal(document.mock.callCount(), 0);
  assert.equal((await fixture.db.list("owner", "tasks")).length, 1);
  await assert.rejects(server.agent.getTask("other-owner", receipt.taskId));
  await server.agent.worker.tick();
  const task = await server.agent.getTask("owner", receipt.taskId);
  assert.equal(task.status, "failed", "An index alone cannot verify a source claim");
  assert.equal(task.originThreadId, "search-chat");
  assert.equal(document.mock.callCount(), 1);
  const operations = await server.agent.journal.operations("owner", task.id);
  assert.equal(operations.filter((op) => op.toolName === "search_web").length, 1);
  const search = operations.find((op) => op.toolName === "search_web");
  assert.equal(searchResultSchema.parse(search?.receipt).provenance.backend, "http");
  assert.ok(
    requests.some(
      (request) =>
        request.body.includes("Index evidence") && request.body.includes("fullPagesRead"),
    ),
  );
  assert.equal(search?.effect, false);
  assert.equal(paths.length, 0, "public search does not dispatch browser work");
});
