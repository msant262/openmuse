import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { WebReadError } from "../apps/server/src/public-web.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const html =
  '<html><title>Promoções de maquiagem</title><main><h1>Batom</h1><p>Preço atual €12, em estoque na Alemanha.</p><a href="/batom">Ver produto</a></main></html>';

test("a worker's 404 receipt exposes the exact discovered URL and preserves the later real read", async (t) => {
  const observed = "https://news.example/results-as-published";
  await modelFixture(
    t,
    (i) =>
      [
        { name: "search_web", arguments: { query: "published results", limit: 1 } },
        { name: "web_extract", arguments: { urls: ["https://news.example/results-shortened"] } },
        { name: "web_fetch", arguments: { url: observed } },
        { name: "finish_task", arguments: { summary: "Candidate A has 52%." } },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.search, "search", async () => ({
    query: "published results",
    status: "ok",
    truncated: false,
    observedAt: new Date().toISOString(),
    sources: [{ url: observed, title: "Published results", snippet: "Read the results" }],
    provenance: {
      backend: "http",
      provider: "bing-rss",
      searchUrl: "https://www.bing.com/search",
      fullPagesRead: false,
    },
  }));
  const reads: string[] = [];
  t.mock.method(f.agent.web, "document", async (url: string) => {
    reads.push(url);
    if (url !== observed) throw new WebReadError("HTTP_404", "Source not found");
    return {
      url,
      contentType: "text/html",
      body: "<title>Published results</title><article>Candidate A has 52%.</article>",
    };
  });
  const task = await f.agent.createTask("owner", { prompt: "Read the published results" });
  await f.agent.worker.tick();
  const result = await f.agent.detail("owner", task.id);
  assert.equal(result.task.status, "succeeded", result.task.error ?? undefined);
  const failed = result.operations.find((op) => op.toolName === "web_extract");
  assert.ok(failed);
  const page = (failed.receipt as { pages: { observedAlternatives: string[]; error: string }[] })
    .pages[0];
  assert.deepEqual(page.observedAlternatives, [observed]);
  assert.ok(page.error);
  assert.deepEqual(reads, ["https://news.example/results-shortened", observed]);
  assert.ok(
    result.task.evidence.some((item) => item.url === observed && item.excerpt.includes("52%")),
  );
});

test("worker web_fetch explicitly escalates pending HTTP data to headless and records the source", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "web_fetch", arguments: { url: "https://news.example/live" } }
      : index === 1
        ? { name: "web_fetch", arguments: { url: "https://news.example/live", mode: "headless" } }
        : {
            name: "finish_task",
            arguments: { summary: "Candidate A has 52% of 12345 votes: https://news.example/live" },
          },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: '<title>Live results</title><main><div class="results-placeholder">Location 0</div></main>',
  }));
  // External rendering is the test boundary; the real reader, journal and verifier run.
  t.mock.method(f.agent.web, "validate", async (url: string) => ({
    url: new URL(url),
    address: "93.184.216.34",
    family: 4,
  }));
  t.mock.method(f.agent.browser, "observe", async (_owner: string, url: string) => ({
    sessionId: randomUUID(),
    url,
    title: "Live results",
    text: "Candidate A has 52% of 12345 votes.",
    truncated: false,
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Read the current count",
    criteria: [
      { id: "votes", kind: "observation", description: "Observed votes", requiredItems: ["12345"] },
    ],
  });
  await f.agent.worker.tick();
  const result = await f.agent.getTask("owner", task.id);
  assert.equal(result.status, "succeeded", result.error ?? result.result);
  assert.match(result.evidence[0].excerpt, /12345/);
  const op = (await f.agent.journal.operations("owner", task.id)).find(
    (op) =>
      op.toolName === "web_fetch" &&
      (op.receipt as { provenance?: { backend: string } })?.provenance?.backend === "browser",
  );
  assert.ok(op);
  assert.equal((op.receipt as { provenance: { backend: string } }).provenance.backend, "browser");
});

test("a declared partial research report cannot pass as a completed task merely because an article was read", async (t) => {
  await modelFixture(
    t,
    (index) =>
      index === 0
        ? { name: "web_fetch", arguments: { url: "https://news.example/about-results" } }
        : {
            name: "finish_task",
            arguments: {
              summary: "Li as instruções, mas não consegui confirmar os resultados atuais.",
              outcome: "partial",
            },
          },
    {
      researchReview: () => ({
        complete: false,
        blocked: true,
        missing: ["The actual count is unavailable in the observed sources"],
        nextSteps: [],
      }),
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<title>About the count</title><article>Results update after polls close. Read the live data on the results page.</article>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "como está a apuração agora?" });
  await f.agent.worker.tick();
  const result = await f.agent.getTask("owner", task.id);
  assert.equal(result.status, "failed");
  assert.equal(result.completion?.status, "partial");
});

test("chat delegates public-page research before the worker reads HTTP text without a browser or question", async (t) => {
  const prompt = "Veja as promoções em https://shop.example/sale";
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "delegate_task", arguments: { kind: "agent", prompt } }
      : index === 2
        ? { name: "web_fetch", arguments: { url: "https://shop.example/sale" } }
        : index === 3
          ? {
              name: "finish_task",
              arguments: { summary: "Batom por €12 na Alemanha: https://shop.example/sale" },
            }
          : undefined,
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await f.db.put("owner", "threads", { id: "makeup" });
  const document = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: html,
  }));
  const events = await lastValueFrom(
    new ConversationAgent(f.agent.config, f.agent, "owner")
      .run({
        threadId: "makeup",
        runId: randomUUID(),
        messages: [
          {
            id: randomUUID(),
            role: "user",
            content: prompt,
          },
        ],
        tools: [],
        context: [],
        state: {},
      })
      .pipe(toArray()),
  );
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  const receipt = JSON.parse(String(result.content));
  assert.equal(receipt.delegated, true);
  assert.equal(receipt.status, "queued");
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(requests.length, 2, "chat completes before the research worker runs");
  assert.equal(document.mock.callCount(), 0);
  assert.equal((await f.db.list("owner", "tasks")).length, 1);
  const accepted = await f.agent.getTask("owner", receipt.taskId);
  assert.equal(accepted.prompt, prompt);
  assert.equal(accepted.originThreadId, "makeup");
  await assert.rejects(f.agent.getTask("other-owner", receipt.taskId));
  await f.agent.worker.tick();
  const task = await f.agent.getTask("owner", receipt.taskId);
  assert.equal(task.status, "succeeded", task.error ?? task.question);
  assert.equal(task.completion?.status, "verified");
  assert.equal(document.mock.callCount(), 1);
  assert.match(task.evidence[0].excerpt, /€12/);
  assert.equal(task.evidence[0].url, "https://shop.example/sale");
  assert.ok(requests[3].body.includes("€12"));
  const operations = await f.agent.journal.operations("owner", task.id);
  assert.equal(operations.find((op) => op.toolName === "web_fetch")?.effect, false);
  assert.equal(
    (await f.db.get("owner", "thread-publications", `task:${task.id}`))?.status,
    "posted",
  );
  assert.equal((await f.db.list("owner", "browsers")).length, 0);
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 0);
});

test("a researched offer becomes observed evidence and finishes without an input card", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "web_fetch", arguments: { url: "https://shop.example/sale" } }
      : {
          name: "finish_task",
          arguments: { summary: "Batom por €12 na Alemanha: https://shop.example/sale" },
        },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: html,
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Pesquise ofertas de batom na Alemanha",
    criteria: [
      {
        id: "offer",
        kind: "observation",
        description: "Preço e produto observados",
        requiredItems: ["Batom", "€12"],
      },
    ],
  });
  await f.agent.worker.tick();
  const result = await f.agent.getTask("owner", task.id);
  assert.equal(result.status, "succeeded", result.error ?? result.question);
  assert.equal(result.completion?.status, "verified");
  assert.match(result.evidence[0].excerpt, /€12/);
  assert.equal(result.evidence[0].url, "https://shop.example/sale");
  assert.ok(result.evidence[0].acquiredAt);
  assert.ok(requests.some((request) => request.body.includes("€12")));
  const operations = await f.agent.journal.operations("owner", task.id);
  assert.equal(operations.find((op) => op.toolName === "web_fetch")?.effect, false);
  assert.equal((await f.db.list("owner", "browsers")).length, 0);
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 0);
});

test("a client challenge cannot become a verified makeup offer", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "web_fetch", arguments: { url: "https://shop.example/sale" } }
      : {
          name: "finish_task",
          arguments: { summary: "Não consegui verificar ofertas atuais; a loja exige um desafio." },
        },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<title>Client Challenge</title><main>A required part of this site couldn’t load. Please check your connection or try using a different browser.</main>",
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Consegue buscar as últimas promoções de maquiagem na Alemanha?",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.completion?.status, "unverified");
  assert.equal(saved.evidence.length, 0);
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 0);
});

test("a store homepage without an observed price cannot satisfy a request for current offers", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "web_fetch", arguments: { url: "https://shop.example/" } }
      : {
          name: "finish_task",
          arguments: { summary: "Encontrei a loja mas nenhum preço atual verificável." },
        },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<title>Cosmetics Shop</title><main>Bem-vindo à loja. Descubra a beleza. Entrega para toda a Alemanha.</main>",
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Consegue buscar as últimas promoções de maquiagem na Alemanha?",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.notEqual(saved.completion?.status, "verified");
});

test("offer completion requires a delivered price matching its source, not a footer or invented amount", async (t) => {
  let summary = "Não consegui verificar nenhuma promoção atual.";
  await modelFixture(t, (index) =>
    index % 2 === 0
      ? { name: "web_fetch", arguments: { url: "https://shop.example/sale" } }
      : { name: "finish_task", arguments: { summary } },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<title>Sale</title><main>Batom por 12,99 € na Alemanha.</main>",
  }));
  for (const text of [
    "Não consegui verificar nenhuma promoção atual.",
    "Batom em promoção por €99,99.",
    "Batom em promoção por 12,99 €.",
  ]) {
    summary = text;
    const task = await f.agent.createTask("owner", {
      prompt: "Pesquise promoções de maquiagem na Alemanha",
    });
    await f.agent.worker.tick();
    const result = await f.agent.getTask("owner", task.id);
    assert.equal(
      result.status,
      text === "Batom em promoção por 12,99 €." ? "succeeded" : "failed",
      text,
    );
  }
});

test("a current percentage promotion can verify without a monetary price", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "web_fetch", arguments: { url: "https://shop.example/coupon" } }
      : {
          name: "finish_task",
          arguments: {
            summary: "A loja oferece 20% em maquiagem com o cupom BEAUTY, na Alemanha.",
          },
        },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<title>Beauty Promotion</title><main>20% Rabatt auf Make-up mit BEAUTY. Gültig für Deutschland.</main>",
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Busque promoções de maquiagem na Alemanha",
  });
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "succeeded");
});

test("delivery charges cannot masquerade as a verified product promotion", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "web_fetch", arguments: { url: "https://shop.example/" } }
      : {
          name: "finish_task",
          arguments: {
            summary: "Não encontrei promoções verificáveis; a loja informa frete de €4,99.",
          },
        },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<title>Cosmetics</title><main>Bem-vindo. Frete de €4,99 para Alemanha.</main>",
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Busque promoções de maquiagem na Alemanha",
  });
  await f.agent.worker.tick();
  const result = await f.agent.getTask("owner", task.id);
  assert.equal(result.status, "failed");
  assert.notEqual(result.completion?.status, "verified");
});
