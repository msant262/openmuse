import assert from "node:assert/strict";
import test from "node:test";
import { readPublicSource } from "../apps/server/src/public-source-cache.ts";
import { preservePublicSource } from "../apps/server/src/public-web.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("a truncated source can be searched and read from its original bytes without browser or computer work", async (t) => {
  const f = await taskRuntime(t);
  const text = `${"Course description. ".repeat(4000)}All lessons are free. Optional certificate costs €20.\nNext section.`;
  const spill = await preservePublicSource(
    f.files,
    "owner",
  )({
    url: "https://courses.example/policy",
    text,
    mimeType: "text/plain",
  });
  const found = await readPublicSource(f.files, "owner", {
    fileId: spill.fileId,
    query: "ALL LESSONS",
    offset: 0,
    limit: 300,
  });
  assert.equal(found.url, "https://courses.example/policy");
  assert.match(found.text, /All lessons are free/);
  assert.equal(found.sha256, spill.sha256);
  assert.equal(found.observedAt, (await f.files.get("owner", spill.fileId)).createdAt);
  assert.equal(found.attachment, false);
  const first = await readPublicSource(f.files, "owner", {
    fileId: spill.fileId,
    offset: 0,
    limit: 100,
  });
  assert.equal(first.nextOffset, 100);
  const second = await readPublicSource(f.files, "owner", {
    fileId: spill.fileId,
    offset: first.nextOffset,
    limit: 100,
  });
  assert.equal(first.text + second.text, text.slice(0, 200));
  await assert.rejects(
    readPublicSource(f.files, "other-owner", { fileId: spill.fileId, offset: 0, limit: 100 }),
  );
});

test("source-cache reading cannot impersonate a public read using an ordinary attachment", async (t) => {
  const f = await taskRuntime(t);
  const file = await f.files.importAttachment(
    "owner",
    "notes.txt",
    Buffer.from("free"),
    "upload",
    "text/plain",
  );
  await assert.rejects(
    readPublicSource(f.files, "owner", { fileId: file.id, offset: 0, limit: 100 }),
    /preserved public source/,
  );
});

test("the real worker reads a preserved source beyond the requested excerpt and uses it as quoted evidence", async (t) => {
  let f: Awaited<ReturnType<typeof taskRuntime>>;
  let reads = 0;
  await modelFixture(
    t,
    async (i) => {
      if (i === 0)
        return {
          name: "web_fetch",
          arguments: { url: "https://courses.example/policy", maxChars: 300 },
        };
      if (i === 1) {
        const source = (await f.db.list<{ id: string; source: string }>("owner", "files")).find(
          (file) => file.source.startsWith("web_fetch:"),
        );
        assert.ok(source);
        return {
          name: "read_web_source",
          arguments: { fileId: source.id, query: "All lessons", offset: 0, limit: 2000 },
        };
      }
      return {
        name: "finish_task",
        arguments: {
          summary:
            "Open AI: all lessons are free. Optional certificate costs €20. https://courses.example/policy",
        },
      };
    },
    {
      researchReview: () => ({
        complete: true,
        missing: [],
        nextSteps: [],
        needsMoreResearch: false,
        accessAudit: [
          {
            option: "Open AI",
            access: "free",
            sourceUrl: "https://courses.example/policy",
            quote: "All lessons are free.",
          },
        ],
      }),
    },
  );
  f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => {
    reads++;
    return {
      url,
      contentType: "text/html",
      body: `<article>${"Course description. ".repeat(3000)}All lessons are free. Optional certificate costs €20.</article>`,
    };
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Find a free AI course and tell me the optional certificate cost.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.equal(reads, 1);
  assert.ok(saved.evidence.some((evidence) => evidence.excerpt.includes("All lessons are free")));
  assert.equal(saved.question, "");
});
