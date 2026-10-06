import assert from "node:assert/strict";
import test from "node:test";
import { computerInstructions } from "../apps/server/src/computer-tools.ts";
import { personalInstructions } from "../apps/server/src/personal-tools.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
  "base64",
);

for (const ending of ["plain clarification", "premature finish"] as const) {
  test(`an image task recovers from ${ending} before any image exists`, async (t) => {
    const clarification =
      "Consigo! Você quer os percentuais da eleição presidencial de 2026, comparando Flávio e Lula?";
    await modelFixture(
      t,
      (i) =>
        [
          ending === "plain clarification"
            ? undefined
            : { name: "finish_task", arguments: { summary: clarification } },
          { name: "web_fetch", arguments: { url: "https://results.example/current" } },
          {
            name: "generate_image",
            arguments: {
              operationId: "current-map",
              prompt: "Geographic map: candidate A 52%, candidate B 48%, from results.example.",
            },
          },
          {
            name: "finish_task",
            arguments: { summary: "O mapa com os percentuais está anexado." },
          },
        ][i],
      { text: (i) => (i === 0 && ending === "plain clarification" ? clarification : undefined) },
    );
    const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
    t.mock.method(f.agent.web, "document", async (url: string) => ({
      url,
      contentType: "text/html",
      body: "<article>Current results: candidate A 52%, candidate B 48%.</article>",
    }));
    t.mock.method(f.agent.media, "generatedImage", async () => {
      const file = await f.files.importAttachment("owner", "map.png", png, "Map", "image/png");
      return f.files.reference("owner", file.id);
    });
    const task = await f.agent.createTask("owner", {
      prompt:
        "consegue gerar um infografico pra mim mostrando os percentuais por estado, eu queria tipo um mapa do brasil mostrando o percetual do flavio e do lula pra eu saber como foi estado por estado",
    });
    await f.agent.worker.tick();
    if (ending === "plain clarification") {
      const pending = await f.agent.detail("owner", task.id);
      assert.equal(
        pending.task.status,
        "queued",
        "a provisional question is not a failed delivery",
      );
      assert.equal(pending.files.length, 0);
      assert.ok(!pending.events.some((event) => event.title === "Partial delivery"));
      await f.agent.worker.tick();
    }
    const result = await f.agent.detail("owner", task.id);
    assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
    assert.equal(result.files.length, 1);
    assert.equal(result.task.completion?.status, "verified");
    const operations = result.operations;
    assert.equal(operations.filter((op) => op.toolName === "web_fetch").length, 1);
    assert.equal(operations.filter((op) => op.toolName === "generate_image").length, 1);
  });
}

test("a genuine missing input pauses an image task through its question tool", async (t) => {
  await modelFixture(t, () => ({
    name: "ask_user",
    arguments: { question: "Qual arquivo devo usar?" },
  }));
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Crie um infográfico usando meu arquivo.",
  });
  await f.agent.worker.tick();
  const result = await f.agent.detail("owner", task.id);
  assert.equal(result.task.status, "waiting_input");
  assert.equal(result.task.question, "Qual arquivo devo usar?");
  assert.equal(result.files.length, 0);
  assert.equal(result.interactions.length, 1);
});

test("a partial image finish continues from an observed unread result link without a second model", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://results.example/guide" } },
        {
          name: "finish_task",
          arguments: { outcome: "partial", summary: "The guide has no result numbers." },
        },
        { name: "web_fetch", arguments: { url: "https://results.example/results" } },
        {
          name: "generate_image",
          arguments: {
            operationId: "follow-result",
            prompt: "Map: candidate A 52%, B 48%, from the read result page.",
          },
        },
        { name: "finish_task", arguments: { summary: "O mapa está anexado." } },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.endsWith("/guide")
      ? '<article>Results are published here: <a href="/results">Read current results</a></article>'
      : "<article>Candidate A 52%, candidate B 48%.</article>",
  }));
  t.mock.method(f.agent.media, "generatedImage", async () => {
    const file = await f.files.importAttachment("owner", "map.png", png, "Map", "image/png");
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Research current results and generate a map infographic.",
  });
  await f.agent.worker.tick();
  const result = await f.agent.detail("owner", task.id);
  assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
  assert.equal(
    (
      result.operations.find((op) => op.toolName === "finish_task")?.receipt as {
        repairable?: boolean;
      }
    ).repairable,
    true,
  );
  assert.equal(result.files.length, 1);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.imageBriefRequests.length, 0);
});

test("an actual public-source blocker can finish partial after the bounded continuation", async (t) => {
  await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://results.example/guide" } },
        {
          name: "finish_task",
          arguments: {
            outcome: "partial",
            summary: "The source does not publish the requested details.",
          },
        },
        {
          name: "finish_task",
          arguments: {
            outcome: "partial",
            summary:
              "There are no result links or values in the available source; the requested details are unavailable.",
          },
        },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<article>Only an announcement is published.</article>",
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Research current results and generate a map infographic.",
  });
  await f.agent.worker.tick();
  const result = await f.agent.detail("owner", task.id);
  assert.equal(result.task.status, "failed");
  assert.equal(result.task.completion?.status, "unverified");
  assert.equal(result.files.length, 0);
  assert.equal(result.operations.filter((op) => op.toolName === "finish_task").length, 2);
});

test("an image task continues after a partial finish that leaves available aggregate rows unread", async (t) => {
  const query = {
    url: "https://results.example/data",
    pointer: "/regions",
    aggregate: {
      groupBy: [{ name: "region", pointer: "/name" }],
      sum: [{ name: "total", pointer: "/votes" }],
    },
  };
  await modelFixture(
    t,
    (i) =>
      [
        { name: "read_web_data", arguments: { ...query, limit: 1 } },
        {
          name: "finish_task",
          arguments: { outcome: "partial", summary: "I could not obtain the remaining regions." },
        },
        { name: "read_web_data", arguments: { ...query, limit: 100 } },
        {
          name: "generate_image",
          arguments: {
            operationId: "all-regions",
            prompt: "Map with every observed region: North 52, South 48.",
          },
        },
        { name: "finish_task", arguments: { summary: "The complete map is attached." } },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "application/json",
    body: JSON.stringify({
      regions: [
        { name: "North", votes: 52 },
        { name: "South", votes: 48 },
      ],
    }),
  }));
  t.mock.method(f.agent.media, "generatedImage", async () => {
    const file = await f.files.importAttachment("owner", "map.png", png, "Map", "image/png");
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Research every region and generate an infographic map.",
  });
  await f.agent.worker.tick();
  const result = await f.agent.detail("owner", task.id);
  assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
  assert.equal(result.files.length, 1);
  const firstFinish = result.operations.find((op) => op.toolName === "finish_task");
  assert.equal((firstFinish?.receipt as { repairable?: boolean })?.repairable, true);
  assert.equal(result.operations.filter((op) => op.toolName === "generate_image").length, 1);
});

for (const vision of [true, false]) {
  test(`the default research and image flow completes without extra reviews with vision=${vision}`, async (t) => {
    const fixture = await modelFixture(
      t,
      (i) =>
        [
          { name: "web_fetch", arguments: { url: "https://results.example/current" } },
          {
            name: "generate_image",
            arguments: {
              operationId: "direct-map",
              prompt: "Geographic map: candidate A 52%, candidate B 48%, from results.example.",
            },
          },
          { name: "finish_task", arguments: { summary: "O mapa está anexado." } },
        ][i],
      { imageBriefErrorStatus: () => 503, reviewErrorStatus: () => 503 },
    );
    const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = vision;
    t.mock.method(f.agent.web, "document", async (url: string) => ({
      url,
      contentType: "text/html",
      body: "<article>Candidate A 52%, candidate B 48%.</article>",
    }));
    let generations = 0;
    t.mock.method(f.agent.media, "generatedImage", async () => {
      generations++;
      const file = await f.files.importAttachment("owner", "map.png", png, "Map", "image/png");
      return f.files.reference("owner", file.id);
    });
    const task = await f.agent.createTask("owner", {
      prompt: "Pesquise os percentuais atuais e gere um mapa infográfico com os dois candidatos.",
    });
    await f.agent.worker.tick();
    const result = await f.agent.detail("owner", task.id);
    assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
    assert.equal(result.task.completion?.status, "verified");
    assert.equal(result.files.length, 1);
    assert.equal(generations, 1);
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.imageBriefRequests.length, 0);
    assert.equal(fixture.reviewRequests.length, 0);
    const instructions = JSON.parse(fixture.requests[0].body).instructions;
    assert.ok(
      !instructions.includes(computerInstructions),
      "deferred computer instructions stay unloaded",
    );
    assert.ok(
      !instructions.includes(personalInstructions),
      "deferred account instructions stay unloaded",
    );
  });
}
