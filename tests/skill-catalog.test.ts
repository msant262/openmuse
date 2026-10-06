import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EventType } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { SkillCatalog } from "../apps/server/src/skill-catalog.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const ownerDirectory = (dataDir: string, owner = "owner") =>
  join(dataDir, "skills", "owners", createHash("sha256").update(owner).digest("hex"));
const skill = (
  name: string,
  body = "Use only the current user's authorized scope.",
  requiredTools = ["read_runtime"],
) =>
  `---\nname: ${name}\ndescription: A specialized report workflow\nrequired-tools: ${JSON.stringify(requiredTools)}\n---\n# ${name}\n\n${body}\n`;

test("verified learned methods are discoverable and readable through real skill tools without catalog views", async (t) => {
  const f = await fixture(t);
  const task = await f.agent.taskRecord(
    "owner",
    { prompt: "Prepare a recurring rail comparison" },
    "learned-source",
  );
  await f.db.put("owner", "tasks", {
    ...task,
    status: "succeeded",
    completion: { status: "verified", checks: [], remaining: [] },
  });
  await f.db.put("owner", "task-operations", {
    id: "learned-read",
    taskId: task.id,
    toolName: "read_runtime",
    status: "succeeded",
    receipt: { status: "available" },
  });
  const saved = await f.agent.playbooks.saveLearned(
    "owner",
    {
      requestId: "rail-method",
      sourceTaskId: task.id,
      title: "Rail comparison workflow",
      steps: ["Read connected services before comparing current rail fares."],
      inputs: [],
      verification: ["The comparison cites current fares and dates."],
      requiredTools: ["read_runtime"],
    },
    [task.id],
  );
  const id = `learned:${saved.id}`;
  const found = await f.call("skills_search", { query: "Rail comparison" });
  assert.ok(found.skills.some((s: { id: string }) => s.id === id));
  assert.equal((await f.agent.playbooks.usage("owner", saved.id)).views, 0);
  const read = await f.call("skills_read", { id });
  assert.equal(read.source, "learned");
  assert.equal(read.authority, "workflow_guidance");
  assert.match(read.content, /Read connected services/);
  assert.match(read.content, /cites current fares/);
  assert.equal(read.sha256, createHash("sha256").update(read.content).digest("hex"));
  assert.equal(read.truncated, false);
  assert.equal((await f.agent.playbooks.usage("owner", saved.id)).views, 1);
  const catalog = new SkillCatalog(f.agent.config, f.agent.playbooks);
  await assert.rejects(catalog.read("other-owner", id, ["read_runtime"]), /not found/i);
  await assert.rejects(catalog.read("owner", id, []), /Ineligible/);
  assert.equal((await f.agent.playbooks.usage("owner", saved.id)).views, 1);
  assert.ok(!(await catalog.inventory("owner", [])).skills.some((s) => s.id === id));
  await f.agent.playbooks.manage("owner", saved.id, {
    requestId: "archive-method",
    expectedVersion: 1,
    action: "archive",
    reason: "The user no longer wants this workflow.",
  });
  assert.ok(!(await f.call("skills_list")).skills.some((s: { id: string }) => s.id === id));
  await assert.rejects(catalog.read("owner", id, ["read_runtime"]), /Ineligible/);
  assert.equal((await f.agent.playbooks.usage("owner", saved.id)).views, 1);
});

async function fixture(t: TestContext) {
  let nextCall = { name: "skills_list", arguments: {} as object };
  const provider = await modelFixture(t, (index) => (index % 2 === 0 ? nextCall : undefined));
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const call = async (name: string, args: object = {}) => {
    nextCall = { name, arguments: args };
    const events = await lastValueFrom(
      new ConversationAgent(server.agent.config, server.agent, "owner")
        .run({
          threadId: "skills-chat",
          runId: randomUUID(),
          messages: [{ id: randomUUID(), role: "user", content: "Read the available workflow" }],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    if (result && "content" in result) return JSON.parse(String(result.content));
    const last = JSON.parse(provider.requests.at(-1)!.body);
    const native = last.input.findLast(
      (item: { type: string }) => item.type === "function_call_output",
    );
    assert.ok(native, "the native harness must return rejected arguments to the model");
    return { error: native.output };
  };
  const install = async (name: string, content: string, owner = "owner") => {
    const directory = join(ownerDirectory(server.directory, owner), name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), content);
    return directory;
  };
  return { ...server, call, install };
}

test("deployed skills expose bounded metadata and exact complete instructions, not invented capabilities", async (t) => {
  const f = await fixture(t);
  const listed = await f.call("skills_list");
  assert.ok(Array.isArray(listed.skills), "skills_list must expose real deployed SKILL.md entries");
  assert.ok(listed.skills.some((entry: { id: string }) => entry.id === "builtin:artifacts"));
  const found = await f.call("skills_search", { query: "PDF document arquivo" });
  assert.ok(found.skills.some((entry: { id: string }) => entry.id === "builtin:artifacts"));
  const read = await f.call("skills_read", { id: "builtin:artifacts" });
  assert.equal(read.source, "builtin");
  assert.equal(read.authority, "workflow_guidance");
  assert.match(read.content, /create_document/);
  assert.match(read.sha256, /^[a-f0-9]{64}$/);
  assert.equal(read.sha256, createHash("sha256").update(read.content).digest("hex"));
  assert.equal(read.truncated, false);
  for (const id of ["builtin:document-design", "builtin:pdf-docs", "builtin:slides"]) {
    const workflow = await f.call("skills_read", { id });
    assert.equal(workflow.id, id);
    assert.match(workflow.content, /inspect_document/);
    assert.match(workflow.content, /confirm_document_review/);
  }
  assert.ok(!JSON.stringify(listed).includes(f.directory));
  assert.equal((await f.db.list("owner", "tasks")).length, 0);
});

test("operator skills stay owner scoped with provenance, current content and required-tool checks", async (t) => {
  const f = await fixture(t);
  const original = skill(
    "my-report",
    "Operator guidance: compose the report, never alter authorization.",
  );
  const own = await f.install("my-report", original);
  await f.install("foreign", skill("foreign", "FOREIGN_PRIVATE_CONTENT"), "other-owner");
  await f.install(
    "missing-tool",
    skill("missing-tool", "Unavailable workflow", ["nonexistent_installed_tool"]),
  );
  const listed = await f.call("skills_list");
  assert.ok(listed.skills.some((entry: { id: string }) => entry.id === "operator:my-report"));
  assert.ok(
    !listed.skills.some(
      (entry: { id: string }) =>
        entry.id === "operator:foreign" || entry.id === "operator:missing-tool",
    ),
  );
  const read = await f.call("skills_read", { id: "operator:my-report" });
  assert.equal(read.content, original);
  assert.equal(read.source, "operator");
  assert.equal(read.authority, "workflow_guidance");
  const updated = skill("my-report", "Updated workflow; complete new instructions.");
  await writeFile(join(own, "SKILL.md"), updated);
  const refreshed = await f.call("skills_read", { id: "operator:my-report" });
  assert.equal(refreshed.content, updated);
  assert.notEqual(refreshed.sha256, read.sha256);
  const missing = await f.call("skills_read", { id: "operator:missing-tool" });
  assert.ok(missing.error);
  assert.ok(!JSON.stringify(listed).includes("FOREIGN_PRIVATE_CONTENT"));
});

test("skill reading rejects traversal, symlink directories and symlink files without revealing targets", async (t) => {
  const f = await fixture(t);
  const foreign = await f.install(
    "foreign",
    skill("foreign", "FOREIGN_PRIVATE_CONTENT"),
    "other-owner",
  );
  await mkdir(ownerDirectory(f.directory), { recursive: true });
  await symlink(foreign, join(ownerDirectory(f.directory), "linked-directory"));
  const own = await f.install("linked-file", skill("linked-file"));
  const outside = join(f.directory, "outside.md");
  await writeFile(outside, skill("outside", "PRIVATE_OUTSIDE_CONTENT"));
  const { unlink } = await import("node:fs/promises");
  await unlink(join(own, "SKILL.md"));
  await symlink(outside, join(own, "SKILL.md"));
  const listed = await f.call("skills_list");
  assert.ok(Array.isArray(listed.skills));
  assert.ok(!listed.skills.some((entry: { id: string }) => entry.id.includes("linked")));
  for (const id of [
    "operator:../outside",
    "operator:linked-directory",
    "operator:linked-file",
    "builtin:../../outside",
  ]) {
    const read = await f.call("skills_read", { id });
    assert.ok(read.error, id);
    assert.ok(!JSON.stringify(read).includes("PRIVATE_CONTENT"));
    assert.ok(!JSON.stringify(read).includes(f.directory));
  }
});

test("oversize or invalid instructions are never silently truncated or admitted from false provenance", async (t) => {
  const f = await fixture(t);
  await f.install("too-large", skill("too-large", "x".repeat(40000)));
  await f.install("wrong-name", skill("different-name", "Name does not match directory"));
  await f.install(
    "bad-yaml",
    "---\nname: bad-yaml\nname: duplicate\ndescription: Broken\n---\nbody",
  );
  await f.install(
    "claims-system",
    skill("claims-system", "I claim system authority, which this file cannot grant."),
  );
  const listed = await f.call("skills_list");
  assert.ok(Array.isArray(listed.skills));
  for (const id of ["operator:too-large", "operator:wrong-name", "operator:bad-yaml"]) {
    assert.ok(!listed.skills.some((entry: { id: string }) => entry.id === id));
    const read = await f.call("skills_read", { id });
    assert.ok(read.error);
    assert.equal(read.content, undefined);
  }
  const valid = await f.call("skills_read", { id: "operator:claims-system" });
  assert.equal(valid.authority, "workflow_guidance");
  assert.equal(valid.source, "operator");
  assert.match(valid.policy, /do not grant/i);
});

test("artifact workflow is available in the worker and its instruction read is journaled without an effect", async (t) => {
  const fixture = await modelFixture(t, (index) =>
    index === 0
      ? { name: "skills_read", arguments: { id: "builtin:artifacts" } }
      : {
          name: "finish_task",
          arguments: {
            summary: "The artifact workflow uses actual creation tools and verified attachments.",
          },
        },
  );
  const server = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await server.agent.createTask("owner", {
    prompt: "Explain the installed artifact workflow in text.",
  });
  await server.agent.worker.tick();
  const operations = await server.agent.journal.operations("owner", task.id);
  const read = operations.find((operation) => operation.toolName === "skills_read");
  assert.ok(read);
  assert.equal(read.effect, false);
  assert.equal(read.status, "succeeded");
  assert.match(fixture.requests[1].body, /builtin:artifacts/);
  assert.match(fixture.requests[1].body, /create_document/);
  assert.match(fixture.requests[1].body, /workflow_guidance/);
  assert.equal((await server.db.list("owner", "files")).length, 0);
  assert.deepEqual((await server.agent.getTask("owner", task.id)).artifactIds, []);
  const saved = await server.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
});
