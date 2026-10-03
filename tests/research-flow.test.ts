import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const html =
  '<html><title>Promoções de maquiagem</title><main><h1>Batom</h1><p>Preço atual €12, em estoque na Alemanha.</p><a href="/batom">Ver produto</a></main></html>';

test("chat web_fetch answers from public HTTP text without a task, browser or question", async (t) => {
  const { requests } = await modelFixture(t, (index) =>
    index === 0
      ? { name: "web_fetch", arguments: { url: "https://shop.example/sale" } }
      : undefined,
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
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
            content: "Veja as promoções em https://shop.example/sale",
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
  assert.match(JSON.parse(String(result.content)).text, /€12/);
  assert.ok(requests[1].body.includes("€12"));
  assert.equal((await f.db.list("owner", "tasks")).length, 0);
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
