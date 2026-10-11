import assert from "node:assert/strict";
import { test } from "node:test";
import { messageContentHash } from "../apps/server/src/conversation-inbox.ts";
import { ModelFileReferences } from "../apps/server/src/engine/file-references.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("the worker receives the accepted message's own attachments before library discovery", async (t) => {
  const fixture = await modelFixture(t, () => ({
    name: "finish_task",
    arguments: { outcome: "partial", summary: "No transcription was performed in this fixture." },
  }));
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const audio = await f.files.importAttachment(
    "owner",
    "Audio - modelo de linguagem.mp3",
    Buffer.from("fixture audio"),
    "Uploaded by you",
    "audio/mpeg",
  );
  await f.files.importAttachment(
    "another-owner",
    "private-owner-audio.mp3",
    Buffer.from("private"),
    "Private",
    "audio/mpeg",
  );
  await f.files.importAttachment(
    "owner",
    "unrelated-older-audio.mp3",
    Buffer.from("other"),
    "Uploaded by you",
    "audio/mpeg",
  );
  const input = {
    threadId: "audio-thread",
    clientMessageId: "audio-message",
    text: "Transcreva o áudio anexado em segundo plano e me entregue o texto.",
    attachmentIds: [audio.id],
  };
  await f.agent.inbox.acceptMessage("owner", { ...input, contentHash: messageContentHash(input) });
  const accepted = await f.agent.inbox.get("owner", input.threadId, input.clientMessageId);
  assert.ok(accepted);
  await f.db.put("owner", "conversation-inbox", { ...accepted, status: "finished" });
  await f.agent.createTask("owner", {
    prompt: input.text,
    originThreadId: input.threadId,
    originMessageId: input.clientMessageId,
  });
  await f.agent.worker.tick();
  assert.ok(fixture.requests.length);
  const body = fixture.requests[0].body;
  assert.match(body, /Audio - modelo de linguagem\.mp3/);
  assert.match(body, /app_file_[a-f0-9]{12}/);
  assert.match(body, /audio\/mpeg/);
  assert.doesNotMatch(body, /private-owner-audio|unrelated-older-audio/);
});

test("short attachment references resolve before the host journal and finish with canonical IDs", async (t) => {
  let reference = "";
  const fixture = await modelFixture(t, (i) => {
    const body = fixture.requests[i].body;
    reference ||= /app_file_[a-f0-9]{12}/.exec(body)?.[0] ?? "";
    assert.ok(reference);
    return i === 0
      ? { name: "attach_saved_file", arguments: { fileId: reference } }
      : {
          name: "finish_task",
          arguments: { summary: "Arquivo entregue.", artifactIds: [reference] },
        };
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const file = await f.files.importAttachment(
    "owner",
    "resultado.txt",
    Buffer.from("Conteúdo do documento solicitado."),
    "Uploaded by you",
    "text/plain",
  );
  const input = {
    threadId: "delivery-thread",
    clientMessageId: "delivery-message",
    text: "Me entregue o documento anexado.",
    attachmentIds: [file.id],
  };
  await f.agent.inbox.acceptMessage("owner", { ...input, contentHash: messageContentHash(input) });
  const accepted = await f.agent.inbox.get("owner", input.threadId, input.clientMessageId);
  assert.ok(accepted);
  await f.db.put("owner", "conversation-inbox", { ...accepted, status: "finished" });
  const task = await f.agent.createTask("owner", {
    prompt: input.text,
    originThreadId: input.threadId,
    originMessageId: input.clientMessageId,
  });
  await f.agent.worker.tick();
  const completed = await f.agent.getTask("owner", task.id);
  assert.equal(completed.status, "succeeded", completed.error ?? completed.result);
  assert.deepEqual(completed.artifactIds, [file.id]);
  const operations = await f.agent.journal.operations("owner", task.id);
  assert.ok(
    operations.some(
      (operation) =>
        operation.toolName === "attach_saved_file" &&
        (operation.args as { fileId: string }).fileId === file.id,
    ),
  );
  assert.doesNotMatch(JSON.stringify(operations), /app_file_/);
});

test("file references survive reconstruction and reject foreign scopes, revisions and corrupted IDs", async (t) => {
  const f = await taskRuntime(t);
  const file = await f.files.importAttachment(
    "owner",
    "own.txt",
    Buffer.from("own"),
    "Uploaded",
    "text/plain",
  );
  const references = new ModelFileReferences(f.files, "owner", "task:one:0");
  const projected = (await references.project({
    fileId: file.id,
    artifactIds: [file.id],
    title: file.id,
  })) as { fileId: string; artifactIds: string[]; title: string };
  assert.match(projected.fileId, /^app_file_[a-f0-9]{12}$/);
  assert.deepEqual(projected.artifactIds, [projected.fileId]);
  assert.equal(projected.title, file.id, "document text must not be rewritten");
  assert.equal(
    await new ModelFileReferences(f.files, "owner", "task:one:0").resolveId(projected.fileId),
    file.id,
  );
  for (const resolver of [
    new ModelFileReferences(f.files, "another-owner", "task:one:0"),
    new ModelFileReferences(f.files, "owner", "task:two:0"),
    new ModelFileReferences(f.files, "owner", "task:one:1"),
  ])
    await assert.rejects(() => resolver.resolveId(projected.fileId), /Unknown app file reference/);
  const corrupted = projected.fileId.slice(0, -1) + (projected.fileId.endsWith("0") ? "1" : "0");
  await assert.rejects(() => references.resolveId(corrupted), /Unknown app file reference/);
  const foreign = new ModelFileReferences(f.files, "another-owner", "task:one:0");
  assert.deepEqual(await foreign.project({ fileId: file.id }), { fileId: file.id });
  const error = (await references.project({ error: "File not found" })) as {
    availableReferences: { fileId: string }[];
  };
  assert.equal(error.availableReferences[0].fileId, projected.fileId);
  assert.deepEqual(
    await references.arguments({ fileId: "google-native-id", content: projected.fileId }),
    { fileId: "google-native-id", content: projected.fileId },
  );
});
