import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { latestJevPanelId } from "../apps/mobile/src/jev-actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { Store } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { JevDecisionInput } from "../apps/server/src/jev/adapter.ts";
import { JevService } from "../apps/server/src/jev/service.ts";
import { presentChoicesParameters } from "../apps/server/src/jev/tools.ts";
import { encodeJevAction } from "../packages/domain/src/jev.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture, richChatFixtureProviders } from "./helpers/model.ts";

const options = [{ id: "explore", label: "Explore exhibits", details: [], sources: [] }];
const comparisonOption = (url: string) => ({
  id: "a",
  label: "A",
  details: [],
  sources: [{ title: "Source", url }],
});

test("refinement may omit options but new panels still need candidates", () => {
  const base = {
    message: "Refine",
    context: "Earlier panel",
    title: "Choices",
    control: "comparison",
  };
  assert.doesNotThrow(() =>
    presentChoicesParameters.parse({ ...base, options: [], refinementPanelId: "previous" }),
  );
  assert.throws(() => presentChoicesParameters.parse({ ...base, options: [] }));
});

test("mail-grounded choices name a thread, while generic clarification needs no mail reference", () => {
  const base = {
    message: "What next?",
    context: "User asked for help",
    title: "Next steps",
    control: "clarification",
    options,
  };
  assert.doesNotThrow(() => presentChoicesParameters.parse(base));
  assert.equal(
    presentChoicesParameters.parse({ ...base, mailThreadId: "trip-thread" }).mailThreadId,
    "trip-thread",
  );
});
function input(content: string, threadId = "jev-thread"): RunAgentInput {
  return {
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content }],
    tools: [],
    context: [],
    state: {},
  };
}
async function recordSource(
  db: Store,
  request: RunAgentInput,
  kind: "web" | "mail",
  reference: string,
  text?: string,
) {
  // Background research supplies verified receipts. Keep real evidence storage
  // and its exact run binding; foreground chat no longer performs source reads.
  const jev = new JevService({
    store: db,
    mode: "live",
    adapter: { decide: async () => ({ control: "comparison", scores: { a: 1 } }) },
  });
  await jev.noteEvidence("local-user", request.threadId, request.runId, kind, reference, text);
  return jev;
}
async function fixture(
  t: TestContext,
  calls: Array<{ name: string; arguments: object } | undefined>,
  modelOptions: Parameters<typeof modelFixture>[2] = {},
) {
  await modelFixture(t, (index) => calls[index], modelOptions);
  const browser = await browserFixture(t, () => ({
    data: { url: "https://example.org", title: "Example", text: "Observed", truncated: false },
  }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
    jevMode: "sample" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  return {
    ...browser,
    ...app,
    conversation: new ConversationAgent(config, app.agent, "local-user"),
  };
}

test("present_choices emits a complete panel and selection uses trusted stored label", async (t) => {
  const f = await fixture(t, [
    {
      name: "present_choices",
      arguments: {
        message: "Help with trip",
        context: "School email",
        title: "What next?",
        control: "clarification",
        options,
      },
    },
    undefined,
  ]);
  await f.workspace.ensureSample("local-user", f.actions);
  const events = await lastValueFrom(
    f.conversation.run(input("Help with aquarium trip")).pipe(toArray()),
  );
  const result = events.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel,
  );
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  const panel = JSON.parse(String(result.content)).panel;
  assert.equal(panel.options[0].label, "Explore exhibits");
  assert.equal(panel.mode, "sample");
  const action = encodeJevAction({
    panelId: panel.id,
    threadId: panel.threadId,
    candidateSetVersion: panel.candidateSetVersion,
    optionId: "explore",
  });
  const selected = await lastValueFrom(f.conversation.run(input(action)).pipe(toArray()));
  assert.equal(selected.at(-1)?.type, EventType.RUN_FINISHED);
  const retried = await lastValueFrom(f.conversation.run(input(action)).pipe(toArray()));
  assert.equal(retried.at(-1)?.type, EventType.RUN_FINISHED);
  const stored = await f.db.get<{ selectedId: string }>(
    "local-user",
    "jev_threads",
    panel.threadId,
  );
  assert.equal(stored?.selectedId, "explore");
});

test("invalid and cross-thread actions return a run error without model execution", async (t) => {
  const f = await fixture(t, []);
  const events = await lastValueFrom(
    f.conversation.run(input("[OpenMuse choice] bad-json")).pipe(toArray()),
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_ERROR);
  const cross = await lastValueFrom(
    f.conversation
      .run(
        input(
          encodeJevAction({
            panelId: "missing",
            threadId: "foreign",
            candidateSetVersion: 1,
            optionId: "a",
          }),
        ),
      )
      .pipe(toArray()),
  );
  assert.equal(cross.at(-1)?.type, EventType.RUN_ERROR);
});

test("live choices reject unobserved source pages without creating a panel", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "present_choices",
          arguments: {
            message: "Compare",
            context: "Claimed research",
            title: "Exhibits",
            control: "comparison",
            options: [
              {
                id: "a",
                label: "A",
                details: [],
                sources: [{ title: "Source", url: "https://example.org/a" }],
              },
            ],
          },
        }
      : undefined,
  );
  const browser = await browserFixture(t, () => ({
    status: 502,
    data: { error: { message: "Read failed" } },
  }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const adapter = { decide: async () => ({ control: "comparison" as const, scores: { a: 1 } }) };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const events = await lastValueFrom(agent.run(input("Compare exhibits")).pipe(toArray()));
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.equal(JSON.parse(String(result.content)).panel, null);
  assert.match(JSON.parse(String(result.content)).error, /Read the source page/);
  assert.deepEqual(await browser.db.list("local-user", "jev_panels"), []);
});

test("a redirected source receipt does not prove the requested URL", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "agent_status", arguments: {} }
      : index === 1
        ? {
            name: "present_choices",
            arguments: {
              message: "Compare",
              context: "Observed page",
              title: "Exhibits",
              control: "comparison",
              options: [comparisonOption("https://example.org/original")],
            },
          }
        : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: {} }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const adapter = { decide: async () => ({ control: "comparison" as const, scores: { a: 1 } }) };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const request = input("Compare exhibits");
  await recordSource(
    browser.db,
    request,
    "web",
    "https://example.org/redirected",
    "Redirected\nOther page",
  );
  const events = await lastValueFrom(agent.run(request).pipe(toArray()));
  const result = events.find(
    (event) =>
      event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel === null,
  );
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.match(JSON.parse(String(result.content)).error, /Read the source page/);
  assert.deepEqual(await browser.db.list("local-user", "jev_panels"), []);
});

test("mail read in an earlier run does not authorize a new live clarification", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "agent_status", arguments: {} }
      : index === 2
        ? {
            name: "present_choices",
            arguments: {
              message: "Trip",
              context: "Earlier mail",
              title: "Next",
              control: "clarification",
              mailThreadId: "trip-thread",
              options,
            },
          }
        : undefined,
  );
  const browser = await browserFixture(t, () => ({
    data: { url: "https://example.org", title: "Example", text: "Observed", truncated: false },
  }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  await app.workspace.ensureSample("local-user", app.actions);
  const adapter = {
    decide: async () => ({ control: "clarification" as const, scores: { explore: 1 } }),
  };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const earlier = input("Read trip mail");
  const jev = await recordSource(browser.db, earlier, "mail", "trip-thread");
  await lastValueFrom(agent.run(earlier).pipe(toArray()));
  const current = input("Now clarify");
  assert.equal(
    await jev.hasEvidence("local-user", earlier.threadId, earlier.runId, "mail", "trip-thread"),
    true,
  );
  assert.equal(
    await jev.hasEvidence("local-user", current.threadId, current.runId, "mail", "trip-thread"),
    false,
  );
  const events = await lastValueFrom(agent.run(current).pipe(toArray()));
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  assert.equal(JSON.parse(String(result.content)).panel, null);
  assert.match(JSON.parse(String(result.content)).error, /Read the referenced email/);
});

test("live refinement reuses verified stored sources with no new source receipt or options", async (t) => {
  let panelId = "";
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "agent_status", arguments: {} }
      : index === 1
        ? {
            name: "present_choices",
            arguments: {
              message: "Compare",
              context: "Observed exhibit",
              title: "Exhibits",
              control: "comparison",
              options: [
                {
                  ...comparisonOption("https://example.org/exhibit"),
                  label: "Observed exhibit",
                  details: ["Observed exhibit facts"],
                  sources: [{ title: "Exhibit", url: "https://example.org/exhibit" }],
                },
              ],
            },
          }
        : index === 3
          ? {
              name: "present_choices",
              arguments: {
                message: "Something hands-on",
                context: "Earlier verified exhibit",
                title: "Hands-on exhibits",
                control: "comparison",
                options: [],
                refinementPanelId: panelId,
              },
            }
          : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: {} }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const adapter = { decide: async () => ({ control: "comparison" as const, scores: { a: 1 } }) };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const request = input("Compare exhibits");
  const jev = await recordSource(
    browser.db,
    request,
    "web",
    "https://example.org/exhibit",
    "Exhibit\nObserved exhibit facts",
  );
  const first = await lastValueFrom(agent.run(request).pipe(toArray()));
  const firstPanel = first.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel,
  );
  assert.ok(firstPanel && firstPanel.type === EventType.TOOL_CALL_RESULT);
  panelId = JSON.parse(String(firstPanel.content)).panel.id;
  const refinement = input("Something hands-on");
  assert.equal(
    await jev.evidenceText(
      "local-user",
      refinement.threadId,
      refinement.runId,
      "web",
      "https://example.org/exhibit",
    ),
    null,
  );
  const second = await lastValueFrom(agent.run(refinement).pipe(toArray()));
  const refined = second.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel,
  );
  assert.ok(refined && refined.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(
    JSON.parse(String(refined.content)).panel.options.map((option: { id: string }) => option.id),
    ["a"],
  );
});

test("generic live clarification succeeds without mail, but an unobserved mail thread does not", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "present_choices",
          arguments: {
            message: "Choose next step",
            context: "User asked",
            title: "Next",
            control: "clarification",
            options,
          },
        }
      : index === 2
        ? {
            name: "present_choices",
            arguments: {
              message: "Choose from email",
              context: "Claimed school email",
              title: "School",
              control: "clarification",
              mailThreadId: "trip-thread",
              options,
            },
          }
        : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: {} }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const adapter = {
    decide: async () => ({ control: "clarification" as const, scores: { explore: 1 } }),
  };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const first = await lastValueFrom(agent.run(input("What next?")).pipe(toArray()));
  assert.ok(
    first.some(
      (event) =>
        event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel,
    ),
  );
  const second = await lastValueFrom(agent.run(input("School email next?")).pipe(toArray()));
  const rejected = second.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(rejected && rejected.type === EventType.TOOL_CALL_RESULT);
  assert.equal(JSON.parse(String(rejected.content)).panel, null);
  assert.match(JSON.parse(String(rejected.content)).error, /Read the referenced email/);
});

test("Jev judges the person's own message, not the agent's summary of it", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "present_choices",
          arguments: {
            message: "Agent paraphrase",
            context: "User asked",
            title: "Next",
            control: "clarification",
            options,
          },
        }
      : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: {} }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const seen: JevDecisionInput[] = [];
  const adapter = {
    decide: async (decision: JevDecisionInput) => {
      seen.push(decision);
      return { control: "clarification" as const, scores: { explore: 1 } };
    },
  };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  await lastValueFrom(agent.run(input("What should I do next?")).pipe(toArray()));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userMessage, "What should I do next?");
  assert.equal(seen[0].message, "Agent paraphrase");
});

test("live comparison rejects a factual detail absent from the read page", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "agent_status", arguments: {} }
      : index === 1
        ? {
            name: "present_choices",
            arguments: {
              message: "Compare",
              context: "Observed exhibit",
              title: "Exhibits",
              control: "comparison",
              options: [
                {
                  ...comparisonOption("https://example.org/exhibit"),
                  label: "Exhibit",
                  sources: [{ title: "Exhibit", url: "https://example.org/exhibit" }],
                  details: ["A bat-ray touch pool"],
                },
              ],
            },
          }
        : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: {} }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const adapter = { decide: async () => ({ control: "comparison" as const, scores: { a: 1 } }) };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const request = input("Compare exhibits");
  await recordSource(
    browser.db,
    request,
    "web",
    "https://example.org/exhibit",
    "Exhibit\nA kelp forest with sardines.",
  );
  const events = await lastValueFrom(agent.run(request).pipe(toArray()));
  const rejected = events.find(
    (event) =>
      event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel === null,
  );
  assert.ok(rejected && rejected.type === EventType.TOOL_CALL_RESULT);
  assert.match(JSON.parse(String(rejected.content)).error, /detail.*source text/);
  assert.deepEqual(await browser.db.list("local-user", "jev_panels"), []);
});

test("an empty source receipt does not authorize a live comparison", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "agent_status", arguments: {} }
      : index === 1
        ? {
            name: "present_choices",
            arguments: {
              message: "Compare",
              context: "Claimed page",
              title: "Exhibits",
              control: "comparison",
              options: [comparisonOption("https://example.org/empty")],
            },
          }
        : undefined,
  );
  const browser = await browserFixture(t, () => ({ data: {} }));
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    modelProviders: richChatFixtureProviders(browser.config.dataDir),
    jevMode: "live" as const,
  };
  const app = await createApp(browser.db, config);
  t.after(() => app.agent.stop());
  const adapter = { decide: async () => ({ control: "comparison" as const, scores: { a: 1 } }) };
  const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
  const request = input("Compare exhibits");
  const jev = await recordSource(browser.db, request, "web", "https://example.org/empty", "  ");
  assert.equal(
    await jev.evidenceText(
      "local-user",
      request.threadId,
      request.runId,
      "web",
      "https://example.org/empty",
    ),
    null,
  );
  const events = await lastValueFrom(agent.run(request).pipe(toArray()));
  const rejected = events.find(
    (event) =>
      event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel === null,
  );
  assert.ok(rejected && rejected.type === EventType.TOOL_CALL_RESULT);
  assert.match(JSON.parse(String(rejected.content)).error, /Read the source page/);
  assert.deepEqual(await browser.db.list("local-user", "jev_panels"), []);
});

for (const [name, candidate, error] of [
  [
    "invented option label",
    { label: "Imaginary reef", details: ["Touch sea stars"], sourceTitle: "Rocky Shore" },
    /label.*source text/,
  ],
  [
    "invented source title",
    { label: "Rocky Shore", details: ["Touch sea stars"], sourceTitle: "Imaginary reef" },
    /source title.*source text/,
  ],
  [
    "no supporting details",
    { label: "Rocky Shore", details: [], sourceTitle: "Rocky Shore" },
    /at least one.*detail/i,
  ],
] as const) {
  test(`live comparison rejects ${name}`, async (t) => {
    const url = "https://example.org/rocky-shore";
    await modelFixture(t, (index) =>
      index === 0
        ? { name: "agent_status", arguments: {} }
        : index === 1
          ? {
              name: "present_choices",
              arguments: {
                message: "Compare",
                context: "Read exhibit page",
                title: "Exhibits",
                control: "comparison",
                options: [
                  {
                    id: "a",
                    label: candidate.label,
                    details: [...candidate.details],
                    sources: [{ title: candidate.sourceTitle, url }],
                  },
                ],
              },
            }
          : undefined,
    );
    const browser = await browserFixture(t, () => ({ data: {} }));
    const config = {
      ...browser.config,
      agentBackend: "model" as const,
      model: "openai/fixture",
      modelProviders: richChatFixtureProviders(browser.config.dataDir),
      jevMode: "live" as const,
    };
    const app = await createApp(browser.db, config);
    t.after(() => app.agent.stop());
    const adapter = { decide: async () => ({ control: "comparison" as const, scores: { a: 1 } }) };
    const agent = new ConversationAgent(config, app.agent, "local-user", adapter);
    const request = input("Compare exhibits");
    await recordSource(
      browser.db,
      request,
      "web",
      url,
      "Rocky Shore\nRocky Shore lets visitors Touch sea stars.",
    );
    const events = await lastValueFrom(agent.run(request).pipe(toArray()));
    const rejected = events.find(
      (event) =>
        event.type === EventType.TOOL_CALL_RESULT &&
        JSON.parse(String(event.content)).panel === null,
    );
    assert.ok(rejected && rejected.type === EventType.TOOL_CALL_RESULT);
    assert.match(JSON.parse(String(rejected.content)).error, error);
    assert.deepEqual(await browser.db.list("local-user", "jev_panels"), []);
  });
}

test("a later ordinary completed turn invalidates a prior choice panel", async (t) => {
  const f = await fixture(t, [
    {
      name: "present_choices",
      arguments: {
        message: "What next?",
        context: "User asked",
        title: "Next",
        control: "clarification",
        options,
      },
    },
    undefined,
    undefined,
  ]);
  const first = await lastValueFrom(f.conversation.run(input("What next?")).pipe(toArray()));
  const result = first.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel,
  );
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  const panel = JSON.parse(String(result.content)).panel;
  const ordinary = await lastValueFrom(
    f.conversation.run(input("Tell me about the weather")).pipe(toArray()),
  );
  assert.equal(ordinary.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(
    (await f.db.get<{ currentPanelId: string | null }>("local-user", "jev_threads", panel.threadId))
      ?.currentPanelId,
    null,
  );
  const action = encodeJevAction({
    panelId: panel.id,
    threadId: panel.threadId,
    candidateSetVersion: panel.candidateSetVersion,
    optionId: "explore",
  });
  const replay = await lastValueFrom(f.conversation.run(input(action)).pipe(toArray()));
  assert.equal(replay.at(-1)?.type, EventType.RUN_ERROR);
});

async function presentPanel(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await lastValueFrom(f.conversation.run(input("What next?")).pipe(toArray()));
  const result = first.find(
    (event) => event.type === EventType.TOOL_CALL_RESULT && JSON.parse(String(event.content)).panel,
  );
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  return JSON.parse(String(result.content)).panel as {
    id: string;
    threadId: string;
    candidateSetVersion: number;
  };
}
const clarify = {
  name: "present_choices",
  arguments: {
    message: "What next?",
    context: "User asked",
    title: "Next",
    control: "clarification",
    options,
  },
};
async function assertRetired(
  f: Awaited<ReturnType<typeof fixture>>,
  panel: Awaited<ReturnType<typeof presentPanel>>,
) {
  const head = await f.db.get<{ currentPanelId: string | null }>(
    "local-user",
    "jev_threads",
    panel.threadId,
  );
  assert.equal(head?.currentPanelId, null);
  const action = encodeJevAction({
    panelId: panel.id,
    threadId: panel.threadId,
    candidateSetVersion: panel.candidateSetVersion,
    optionId: "explore",
  });
  const replay = await lastValueFrom(f.conversation.run(input(action)).pipe(toArray()));
  assert.equal(replay.at(-1)?.type, EventType.RUN_ERROR);
}

test("an ordinary turn that fails still retires the earlier choice, as the transcript does", async (t) => {
  const f = await fixture(t, [clarify], {
    errorStatus: (index) => (index >= 2 ? 400 : undefined),
  });
  const panel = await presentPanel(f);
  // The mobile transcript treats any later user message as making the panel stale.
  const transcript = [
    { role: "assistant", toolCalls: [{ id: "call-0", name: "present_choices" }] },
    { role: "tool", toolCallId: "call-0", content: JSON.stringify({ panel }) },
    { role: "user", content: "Tell me about the weather" },
  ];
  assert.equal(latestJevPanelId(transcript, panel.threadId), null);
  const failed = await lastValueFrom(
    f.conversation.run(input("Tell me about the weather")).pipe(toArray()),
  ).catch((error: unknown) => error);
  assert.ok(
    failed instanceof Error ||
      (Array.isArray(failed) && failed.at(-1)?.type === EventType.RUN_ERROR),
  );
  await assertRetired(f, panel);
});

test("cancelling an ordinary turn still retires the earlier choice", async (t) => {
  const f = await fixture(t, [clarify]);
  const panel = await presentPanel(f);
  const sampleAgent = new ConversationAgent(
    { ...f.config, agentBackend: "sample", jevMode: "sample" },
    f.agent,
    "local-user",
  );
  await new Promise<void>((resolve, reject) => {
    const subscription = sampleAgent.run(input("hello")).subscribe({
      next: (event) => {
        if (event.type === EventType.RUN_STARTED) {
          subscription.unsubscribe();
          resolve();
        }
      },
      error: reject,
    });
  });
  await assertRetired(f, panel);
});

test("a run resuming after a tool result is not a new turn and keeps the choice", async (t) => {
  const f = await fixture(t, [clarify]);
  const panel = await presentPanel(f);
  const resumed = input("What next?");
  resumed.messages.push({ id: randomUUID(), role: "tool", toolCallId: "open-1", content: "{}" });
  await lastValueFrom(f.conversation.run(resumed).pipe(toArray()));
  const head = await f.db.get<{ currentPanelId: string | null }>(
    "local-user",
    "jev_threads",
    panel.threadId,
  );
  assert.equal(head?.currentPanelId, panel.id);
});

test("only the turn that retired a panel may refine it", async (t) => {
  const f = await fixture(t, [clarify]);
  const panel = await presentPanel(f);
  await lastValueFrom(f.conversation.run(input("Tell me about the weather")).pipe(toArray()));
  const jev = new JevService({
    store: f.agent.db,
    adapter: { decide: async () => ({ control: "clarification", scores: { explore: 1 } }) },
    mode: "sample",
  });
  await assert.rejects(
    jev.createPanel(
      "local-user",
      panel.threadId,
      "a-later-turn",
      {
        message: "Refine",
        context: "x",
        title: "Next",
        control: "clarification",
        options: [],
        refinementPanelId: panel.id,
      },
      new AbortController().signal,
    ),
    /superseded/,
  );
});
