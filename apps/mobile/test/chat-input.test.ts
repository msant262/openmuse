import assert from "node:assert/strict";
import { test } from "node:test";
import { AttachmentQueue, type PendingAttachment } from "../src/attachment-queue.ts";
import type { MessageStorage } from "../src/message-storage.ts";
import { stageSharedInput } from "../src/share-intake.ts";

function storage(): MessageStorage {
  const records = new Map<string, string>();
  return {
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => {
      records.set(key, value);
    },
    update: async (key, change) => {
      const next = change(records.get(key) ?? null);
      records.set(key, next);
      return next;
    },
  };
}
const file: PendingAttachment = {
  id: "upload-one",
  key: "cache-one",
  name: "voice.m4a",
  mimeType: "audio/mp4",
  size: 100,
  sha256: "a".repeat(64),
  transcribe: true,
};
test("pending chat uploads survive reopen and a lost ACK with the same identity and hash", async () => {
  const disk = storage();
  const calls: PendingAttachment[] = [];
  let fail = true;
  const upload = async (item: PendingAttachment) => {
    calls.push(item);
    if (fail) {
      fail = false;
      throw new Error("lost ACK");
    }
    return { id: "saved-file" };
  };
  const first = new AttachmentQueue("paired:thread", disk, upload);
  await first.add(file);
  await first.flush();
  const reopened = new AttachmentQueue("paired:thread", disk, upload);
  assert.equal((await reopened.list())[0].error, "lost ACK");
  await Promise.all([reopened.flush(), reopened.flush()]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((item) => item.id === file.id && item.sha256 === file.sha256));
  assert.equal((await reopened.list())[0].fileId, "saved-file");
  await reopened.patch(file.id, { commandId: "native-command" });
  assert.equal(
    (await new AttachmentQueue("paired:thread", disk, upload).list())[0].commandId,
    "native-command",
  );
  assert.deepEqual(await new AttachmentQueue("other:thread", disk, upload).list(), []);
});
test("upload result does not drop another queued attachment and storage failure does not claim durable upload", async () => {
  const disk = storage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = new AttachmentQueue("chat", disk, async () => {
    await gate;
    return { id: "first-file" };
  });
  await queue.add(file);
  const sending = queue.flush();
  await queue.add({ ...file, id: "upload-two" });
  release();
  await sending;
  assert.equal((await queue.list()).length, 2);
  const failed = storage();
  failed.update = async () => {
    throw new Error("disk full");
  };
  let calls = 0;
  const unavailable = new AttachmentQueue("chat", failed, async () => {
    calls++;
    return { id: "never" };
  });
  await assert.rejects(unavailable.add(file), /disk full/);
  await unavailable.flush();
  assert.equal(calls, 0);
  await assert.rejects(queue.add({ ...file, id: "big", size: 26 * 1024 * 1024 }), /25 MB/);
});

test("Android shared files are copied durably and retried without duplicate queue entries or automatic sending", async () => {
  const disk = storage();
  let uploads = 0,
    copies = 0;
  const queue = new AttachmentQueue("paired:main", disk, async () => {
    uploads++;
    return { id: "server-file" };
  });
  const input = {
    files: [
      { path: "content://sender/a", fileName: "a.pdf", mimeType: "application/pdf", size: 80 },
      { path: "file:///cache/b.jpg", fileName: "b.jpg", mimeType: "image/jpeg", size: 80 },
    ],
  };
  const cache = async (key: string) => {
    if (++copies === 2) throw new Error("copy interrupted");
    return { ...file, key };
  };
  await assert.rejects(stageSharedInput(input, queue, cache, cache), /copy interrupted/);
  assert.equal((await queue.list()).length, 1);
  const reopened = new AttachmentQueue("paired:main", disk, async () => {
    uploads++;
    return { id: "server-file" };
  });
  assert.equal(await stageSharedInput(input, reopened, cache, cache), 2);
  assert.equal((await reopened.list()).length, 2);
  assert.equal(uploads, 0);
  await assert.rejects(
    stageSharedInput(
      { files: [{ ...input.files[0], path: "https://untrusted/secret" }] },
      queue,
      cache,
      cache,
    ),
    /locais/,
  );
  await assert.rejects(
    stageSharedInput({ text: "x".repeat(24001) }, queue, cache, cache),
    /24.000/,
  );
});
