import assert from "node:assert/strict";
import { test } from "node:test";
import { personalTools } from "../apps/server/src/personal-tools.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

async function fixture(t: Parameters<typeof taskRuntime>[0]) {
  const runtime = await taskRuntime(t);
  const source = await runtime.agent.createTask("owner", {
    prompt: "Summarize weekly agenda",
    originThreadId: "main",
  });
  await runtime.db.compareAndSwapTask(
    "owner",
    source.id,
    { status: "queued" },
    {
      status: "succeeded",
      completion: { status: "verified", checks: [], remaining: [] },
    },
  );
  const input = {
    requestId: "save-one",
    sourceTaskId: source.id,
    title: "Agenda semanal",
    steps: ["Read the requested dates using the authorized calendar", "Prepare a summary"],
    inputs: [{ name: "week", label: "Week", required: true }],
    verification: ["Summary covers the requested dates"],
    requiredTools: ["read_calendar"],
  };
  return { ...runtime, source, input };
}
test("procedure saves only verified work; same request retries exactly and competing versions cannot overwrite", async (t) => {
  const f = await fixture(t);
  const first = await f.agent.playbooks.save("owner", f.input);
  assert.equal(first.version, 1);
  assert.deepEqual(await f.agent.playbooks.save("owner", f.input), first);
  await assert.rejects(
    f.agent.playbooks.save("owner", { ...f.input, steps: ["Different"] }),
    /other procedure/,
  );
  const attempts = await Promise.allSettled(
    ["a", "b"].map((title) =>
      f.agent.playbooks.save("owner", {
        ...f.input,
        id: first.id,
        expectedVersion: 1,
        requestId: title,
        title,
      }),
    ),
  );
  assert.equal(attempts.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal((await f.agent.playbooks.get("owner", first.id)).versions.length, 2);
  await assert.rejects(f.agent.playbooks.get("other", first.id), /not found/);
  for (const name of ["password", "senha", "api_key"]) {
    await assert.rejects(
      f.agent.playbooks.save("owner", {
        ...f.input,
        requestId: `field-${name}`,
        inputs: [{ name, label: "Login", required: true }],
      }),
      /Credentials require/,
    );
  }
  const pending = await f.agent.createTask("owner", { prompt: "Pending task" });
  await assert.rejects(
    f.agent.playbooks.save("owner", { ...f.input, requestId: "pending", sourceTaskId: pending.id }),
    /verified/,
  );
  await assert.rejects(
    f.agent.playbooks.save("owner", {
      ...f.input,
      requestId: "secret",
      steps: ["Use senha: do-not-store"],
    }),
    /credential/,
  );
});
test("procedure execution pins version and inputs atomically, retains id after lost ACK and obeys pause", async (t) => {
  const f = await fixture(t);
  const first = await f.agent.playbooks.save("owner", f.input);
  const raw = { version: 1, requestId: "run-one", inputs: { week: "2026-W40" } };
  const tasks = await Promise.all([
    f.agent.playbooks.run("owner", first.id, raw),
    f.agent.playbooks.run("owner", first.id, raw),
  ]);
  assert.equal(tasks[0].id, tasks[1].id);
  assert.equal(tasks[0].status, "queued");
  assert.deepEqual(tasks[0].input.procedure, { id: first.id, version: 1, inputs: raw.inputs });
  await assert.rejects(
    f.agent.playbooks.run("owner", first.id, { ...raw, inputs: { week: "different" } }),
    /different inputs/,
  );
  await f.agent.playbooks.save("owner", {
    ...f.input,
    id: first.id,
    expectedVersion: 1,
    requestId: "v2",
    steps: ["New steps"],
  });
  assert.ok((await f.agent.getTask("owner", tasks[0].id)).prompt.includes("Prepare a summary"));
  assert.ok(!(await f.agent.getTask("owner", tasks[0].id)).prompt.includes("New steps"));
  await assert.rejects(
    f.agent.playbooks.run("owner", first.id, {
      ...raw,
      requestId: "extra",
      inputs: { week: "x", unexpected: "y" },
    }),
    /extra fields/,
  );
  const pause = await f.agent.runtimePause.get("owner");
  await f.agent.runtimePause.set("owner", { paused: true, expectedRevision: pause.revision });
  await assert.rejects(
    f.agent.playbooks.run("owner", first.id, { ...raw, requestId: "paused" }),
    /paused|pause/i,
  );
  assert.equal((await f.agent.playbooks.run("owner", first.id, raw)).id, tasks[0].id);
});
test("procedure tools report missing capability without installing or granting it; task context cannot save/run", async (t) => {
  const f = await fixture(t);
  const first = await f.agent.playbooks.save("owner", f.input);
  assert.deepEqual(
    await f.agent.playbooks.missingTools("owner", { procedure: { id: first.id, version: 1 } }, []),
    ["read_calendar"],
  );
  assert.deepEqual(
    await f.agent.playbooks.missingTools("owner", { procedure: { id: first.id, version: 1 } }, [
      "read_calendar",
    ]),
    [],
  );
  assert.ok(
    !personalTools(f.agent, "owner", "task:untrusted").some((tool) =>
      ["save_procedure", "run_procedure"].includes(tool.name),
    ),
  );
  await assert.rejects(
    f.agent.playbooks.save(
      "owner",
      { ...f.input, requestId: "invented" },
      { messageId: "absent", threadId: "main", runId: "none" },
    ),
    /explicit request/,
  );
});
