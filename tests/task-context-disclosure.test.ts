import assert from "node:assert/strict";
import test from "node:test";
import { messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("public research does not load Workspace mutation instructions into every model turn", async (t) => {
  const fixture = await modelFixture(t, (i) =>
    i === 0
      ? { name: "web_fetch", arguments: { url: "https://research.example/course" } }
      : { name: "finish_task", arguments: { summary: "The course has six lessons." } },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>The course has six lessons.</main>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "Pesquise quantas aulas tem o curso." });
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "succeeded");
  for (const request of fixture.requests)
    assert.doesNotMatch(
      request.body,
      /For deleting a group of emails|For Calendar work, preserve|Gmail folders are labels/,
    );
});

test("a natural Python Calendar request receives scheduling guidance before its first tool call", async (t) => {
  const fixture = await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { outcome: "partial", summary: "No event was created." },
  }));
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  await f.agent.createTask("owner", {
    prompt:
      "Use uma sessão Python para criar na minha agenda o compromisso QA Python A 20261010 amanhã às 11h, com 15 minutos de duração, no fuso Europe/Berlin.",
  });
  await f.agent.worker.tick();
  assert.ok(fixture.requests.length);
  assert.match(fixture.requests[0].body, /Dates in event titles, subjects, filenames/);
  assert.match(fixture.requests[0].body, /Resolve tomorrow and other relative dates/);
  assert.doesNotMatch(fixture.requests[0].body, /Gmail folders are labels|For Drive name lookup/);
});

test("the first worker request separates scheduling fields from numeric dates in literal event titles", async (t) => {
  const fixture = await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { outcome: "partial", summary: "No event was created." },
  }));
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt:
      "Use uma sessão Python para criar dois compromissos na agenda da conta test@example.com para amanhã: Revisão 20261010 às 11h e Entrega 20260901 às 12h, ambos com 15 minutos de duração, no fuso Europe/Berlin.",
  });
  await f.agent.worker.tick();
  const instructions = JSON.parse(fixture.requests[0].body).instructions as string;
  const serialized = /Calendar fields parsed[^\n]*?: (\{[^\n]+?\})\. schedulingDate/.exec(
    instructions,
  );
  assert.ok(serialized);
  const fields = JSON.parse(serialized[1]);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(
    new Date(task.createdAt),
  );
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  assert.equal(fields.schedulingDate, tomorrow.toISOString().slice(0, 10));
  assert.equal(fields.account, "test@example.com");
  assert.equal(fields.referenceTimestamp, task.createdAt);
  assert.deepEqual(fields.events, [
    { title: "Revisão 20261010", localTime: "11:00" },
    { title: "Entrega 20260901", localTime: "12:00" },
  ]);
});

for (const matchingMessage of [true, false])
  test(`Calendar context uses the server acceptance time only for the matching original message (${matchingMessage})`, async (t) => {
    const fixture = await modelFixture(t, () => ({
      name: "finish_task",
      arguments: { outcome: "partial", summary: "No event was created." },
    }));
    const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    const prompt = "Crie na agenda para amanhã: Revisão 20261010 às 11h no fuso Europe/Berlin.";
    const input = {
      threadId: "fixture-thread",
      clientMessageId: "original-message",
      text: matchingMessage ? prompt : "Uma mensagem diferente.",
      attachmentIds: [],
    };
    await f.agent.inbox.acceptMessage("owner", {
      ...input,
      contentHash: messageContentHash(input),
    });
    const accepted = await f.agent.inbox.get("owner", input.threadId, input.clientMessageId);
    assert.ok(accepted);
    await f.db.put("owner", "conversation-inbox", {
      ...accepted,
      createdAt: "2026-10-10T21:59:59.000Z",
      // This contract starts at the completed foreground handoff. A pending
      // inbox would launch a second foreground model alongside this worker.
      status: "finished",
    });
    const task = await f.agent.createTask("owner", {
      prompt,
      originThreadId: input.threadId,
      originMessageId: input.clientMessageId,
    });
    await f.agent.worker.tick();
    const instructions = JSON.parse(fixture.requests[0].body).instructions as string;
    const serialized = /Calendar fields parsed[^\n]*?: (\{[^\n]+?\})\. schedulingDate/.exec(
      instructions,
    );
    assert.ok(serialized);
    const fields = JSON.parse(serialized[1]);
    assert.equal(
      fields.referenceTimestamp,
      matchingMessage ? "2026-10-10T21:59:59.000Z" : task.createdAt,
    );
    if (matchingMessage) assert.equal(fields.schedulingDate, "2026-10-11");
  });
