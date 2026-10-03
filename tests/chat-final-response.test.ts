import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import { lastValueFrom, toArray } from "rxjs";
import { z } from "zod";
import { tanstackAgent } from "../apps/server/src/engine/tanstack-agent.ts";
import { modelFixture } from "./helpers/model.ts";

const input = () => ({
  threadId: "final-response",
  runId: randomUUID(),
  state: {},
  messages: [{ id: "user", role: "user" as const, content: "Pesquise ofertas de batom." }],
  tools: [],
  context: [],
});
const readTool = (execute: () => Promise<unknown>) =>
  defineTool({
    name: "read_offer",
    description: "Read a public product offer",
    parameters: z.object({}),
    execute,
  });
const text = (events: BaseEvent[]) =>
  events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK)
    .map((event) => (event as { delta?: string }).delta ?? "")
    .join("");
const collect = (agent: ReturnType<typeof tanstackAgent>) =>
  lastValueFrom(agent.run(input()).pipe(toArray()));

test("chat reserves its last model turn for a sourced answer without tools or a continue request", async (t) => {
  const answer = "Batom por €12: https://shop.example/batom. Não consegui verificar outras lojas.";
  const fixture = await modelFixture(
    t,
    (index) =>
      JSON.parse(fixture.requests[index].body).tools?.length
        ? { name: "read_offer", arguments: {} }
        : undefined,
    {
      text: (index) =>
        JSON.parse(fixture.requests[index].body).tools?.length ? undefined : answer,
    },
  );
  let reads = 0;
  let safePoints = 0;
  const events = await collect(
    tanstackAgent({
      model: "openai/fixture",
      maxSteps: 3,
      finalResponseOnStepLimit: true,
      prompt: "Research using public sources.",
      promptContext: async () => `Trusted context revision ${++safePoints}.`,
      stepLimitNote: "I reached my step limit. Say continue.",
      tools: [
        readTool(async () => ({
          read: ++reads,
          url: "https://shop.example/batom",
          text: "Batom €12 em estoque",
        })),
      ],
    }),
  );
  assert.equal(reads, 2, "the third turn must be reserved for delivery, not another read");
  assert.equal(fixture.requests.length, 3);
  const final = JSON.parse(fixture.requests[2].body);
  assert.equal(final.tools?.length ?? 0, 0, "all server and state tools are removed");
  assert.match(JSON.stringify(final.input), /Batom €12 em estoque/);
  assert.match(JSON.stringify(final), /Trusted context revision 4/);
  assert.match(JSON.stringify(final), /final response/i);
  assert.equal(text(events), answer);
  assert.ok(events.some((event) => event.type === EventType.RUN_FINISHED));
  assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
});

test("task runs keep their existing tool budget and step-limit callback by default", async (t) => {
  const fixture = await modelFixture(t, () => ({ name: "read_offer", arguments: {} }));
  let reads = 0;
  let limits = 0;
  const events = await collect(
    tanstackAgent({
      model: "openai/fixture",
      maxSteps: 2,
      prompt: "Task fixture",
      onStepLimit: () => limits++,
      stepLimitNote: "Task budget exhausted.",
      tools: [readTool(async () => ({ read: ++reads }))],
    }),
  );
  assert.equal(reads, 2);
  assert.equal(fixture.requests.length, 2);
  assert.equal(limits, 1);
  assert.equal(text(events), "Task budget exhausted.");
});

test("a stopped task is not forced into the reserved final turn", async (t) => {
  const fixture = await modelFixture(t, () => ({ name: "read_offer", arguments: {} }));
  let continuing = true;
  let limits = 0;
  await collect(
    tanstackAgent({
      model: "openai/fixture",
      maxSteps: 2,
      finalResponseOnStepLimit: true,
      prompt: "Stop after a durable delegate receipt.",
      shouldContinue: () => continuing,
      onStepLimit: () => limits++,
      tools: [
        readTool(async () => {
          continuing = false;
          return { taskId: "durable-task", status: "queued" };
        }),
      ],
    }),
  );
  assert.equal(fixture.requests.length, 1);
  assert.equal(limits, 0);
});

test("an answer before the final slot does not trigger an extra model request", async (t) => {
  const fixture = await modelFixture(t, () => undefined, { text: () => "Resposta completa." });
  const events = await collect(
    tanstackAgent({
      model: "openai/fixture",
      maxSteps: 3,
      finalResponseOnStepLimit: true,
      prompt: "Reply directly when sufficient.",
      tools: [],
    }),
  );
  assert.equal(fixture.requests.length, 1);
  assert.equal(text(events), "Resposta completa.");
});

test("abort during a tool never dispatches the reserved final response", async (t) => {
  const fixture = await modelFixture(t, () => ({ name: "read_offer", arguments: {} }));
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  const agent = tanstackAgent({
    model: "openai/fixture",
    maxSteps: 2,
    finalResponseOnStepLimit: true,
    prompt: "Research fixture",
    tools: [
      readTool(async () => {
        entered();
        await receipt;
        return { text: "Batom €12" };
      }),
    ],
  });
  const events: BaseEvent[] = [];
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const subscription = agent.run(input()).subscribe({
    next: (event) => events.push(event),
    error: () => settle(),
    complete: () => settle(),
  });
  t.after(() => {
    release();
    subscription.unsubscribe();
  });
  await started;
  agent.abortRun();
  release();
  await done;
  assert.equal(fixture.requests.length, 1);
  assert.equal(text(events), "");
});
