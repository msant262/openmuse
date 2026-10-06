import assert from "node:assert/strict";
import test from "node:test";
import { computerInstructions } from "../apps/server/src/computer-tools.ts";
import { documentInstructions, imageInstructions } from "../apps/server/src/media-tools.ts";
import { personalInstructions } from "../apps/server/src/personal-tools.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
  "base64",
);

test("a prose response after a draft cannot certify an incomplete image request", async (t) => {
  let finalId = "";
  await modelFixture(
    t,
    (i) =>
      [
        {
          name: "generate_image",
          arguments: { operationId: "draft", prompt: "National summary only." },
        },
        undefined,
        { name: "web_fetch", arguments: { url: "https://results.example/states" } },
        {
          name: "generate_image",
          arguments: {
            operationId: "complete-map",
            prompt: "State A: 52/48. State B: 48/52. Complete map.",
          },
        },
        {
          name: "finish_task",
          arguments: {
            outcome: "completed",
            summary: "Complete state comparison attached.",
            artifactIds: [finalId],
          },
        },
      ][i],
    {
      text: (i) =>
        i === 1 ? "Here is the national summary. State percentages were not confirmed." : undefined,
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<article>State A: 52/48. State B: 48/52.</article>",
  }));
  let generations = 0;
  t.mock.method(f.agent.media, "generatedImage", async () => {
    generations++;
    const file = await f.files.importAttachment(
      "owner",
      `map-${generations}.png`,
      png,
      "Map",
      "image/png",
    );
    finalId = file.id;
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Create a map infographic comparing percentages for every state.",
  });
  await f.agent.worker.tick();
  const draft = await f.agent.detail("owner", task.id);
  assert.equal(draft.task.status, "queued");
  assert.equal(draft.files.length, 0, "an unfinished draft must not be delivered as success");
  assert.equal(draft.task.artifactIds.length, 1);
  await f.agent.worker.tick();
  const result = await f.agent.detail("owner", task.id);
  assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
  assert.equal(generations, 2);
  assert.deepEqual(
    result.files.map((file) => file.id),
    [finalId],
  );
});

test("a misplaced data expansion is rejected instead of silently returning incomplete rows", async (t) => {
  const url = "https://results.example/records.json";
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "read_web_data", arguments: { url, expand: "/items" } },
        {
          name: "read_web_data",
          arguments: {
            url,
            aggregate: {
              expand: "/items",
              groupBy: [{ name: "candidate", pointer: "/item/name" }],
              sum: [{ name: "votes", pointer: "/item/votes" }],
            },
          },
        },
        { name: "finish_task", arguments: { summary: "Candidate A received 12 votes." } },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  let reads = 0;
  t.mock.method(f.agent.web, "readData", async () => {
    reads++;
    return {
      url,
      observedAt: new Date().toISOString(),
      rows: [{ candidate: "A", votes: 12 }],
      total: 1,
      offset: 0,
      nextOffset: null,
      truncated: false,
    };
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Count the published candidate votes.",
  });
  await f.agent.worker.tick();
  const result = await f.agent.detail("owner", task.id);
  assert.equal(result.task.status, "succeeded", result.task.error ?? result.task.question);
  assert.equal(reads, 1, "the malformed query must not fetch or appear as successful evidence");
  assert.match(fixture.requests[1].body, /[Uu]nrecognized|expand/);
});

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
  const finish = result.operations.find((op) => op.toolName === "finish_task");
  assert.ok(finish);
  assert.equal((finish.receipt as { repairable?: boolean }).repairable, true);
  assert.deepEqual((finish.receipt as { unreadSourceLinks?: unknown[] }).unreadSourceLinks, [
    { title: "Read current results", url: "https://results.example/results" },
  ]);
  assert.equal(result.files.length, 1);
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.imageBriefRequests.length, 0);
});

test("a partial saved image continues as new research progresses and delivers only the corrected artifact", async (t) => {
  let draftId = "",
    finalId = "";
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://results.example/guide" } },
        {
          name: "generate_image",
          arguments: { operationId: "draft", prompt: "National-only data-pending map." },
        },
        {
          name: "finish_task",
          arguments: {
            outcome: "partial",
            summary: "The draft lacks regional results.",
            artifactIds: [draftId],
          },
        },
        { name: "web_fetch", arguments: { url: "https://results.example/regional" } },
        {
          name: "finish_task",
          arguments: {
            outcome: "partial",
            summary: "The regional page links to its full data.",
            artifactIds: [draftId],
          },
        },
        { name: "web_fetch", arguments: { url: "https://results.example/data" } },
        {
          name: "generate_image",
          arguments: {
            operationId: "final",
            prompt: "Regional map: North A 52% B 48%; South A 41% B 59%.",
          },
        },
        {
          name: "finish_task",
          arguments: {
            outcome: "completed",
            summary: "The regional map is attached.",
            artifactIds: [finalId],
          },
        },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.endsWith("/guide")
      ? '<article>National summary. <a href="/regional">Regional results</a></article>'
      : url.endsWith("/regional")
        ? '<article>Regional coverage. <a href="/data">Full data</a></article>'
        : "<article>North: A 52%, B 48%. South: A 41%, B 59%.</article>",
  }));
  let generations = 0;
  t.mock.method(f.agent.media, "generatedImage", async () => {
    const final = generations++ > 0;
    const file = await f.files.importAttachment(
      "owner",
      final ? "final.png" : "draft.png",
      final ? Buffer.concat([png, Buffer.from("\n")]) : png,
      "Map",
      "image/png",
    );
    if (final) finalId = file.id;
    else draftId = file.id;
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Research the regional percentages and create a map infographic.",
  });
  await f.agent.worker.tick();
  const result = await f.agent.detail("owner", task.id);
  assert.equal(result.task.status, "succeeded", result.task.error ?? undefined);
  assert.equal(generations, 2);
  assert.notEqual(draftId, finalId);
  assert.deepEqual(result.task.state.deliveryCandidateArtifactIds, [finalId]);
  const repairs = result.operations.filter(
    (op) => op.toolName === "finish_task" && (op.receipt as { repairable?: boolean })?.repairable,
  );
  assert.equal(
    repairs.length,
    2,
    "new source evidence allows another continuation despite the saved draft",
  );
  assert.equal(fixture.reviewRequests.length, 0);
  assert.equal(fixture.imageBriefRequests.length, 0);
  assert.equal(fixture.requests.length, 8);
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
    await f.agent.profiles.update("owner", {
      scope: { kind: "global" },
      patch: { personality: "Warm and clear; preserve factual precision." },
      expectedRevision: 0,
      requestId: "single-executor-image",
      origin: { kind: "settings" },
    });
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
      instructions.includes(imageInstructions),
      "image instructions accompany visible image tools",
    );
    assert.ok(
      !instructions.includes(documentInstructions),
      "image research does not load PDF and Office authoring instructions",
    );
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
