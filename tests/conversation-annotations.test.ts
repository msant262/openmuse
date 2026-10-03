import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createConversationAnnotationValidator } from "../apps/server/src/conversation-annotations.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AcceptedMessageInput } from "../packages/domain/src/runtime.ts";

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

test("annotation admission requires same-owner message and exact current attachment bytes", async () => {
  const db = await createStore();
  const bytes = new Uint8Array([1, 2, 3]);
  const files = new Map<string, Uint8Array>([
    ["owner:file-a", bytes],
    ["other-owner:foreign-file", new Uint8Array([9, 9, 9])],
  ]);
  const messages = new Map([
    ["owner:chat", [{ id: "source", role: "assistant", content: "Look at this exact paragraph." }]],
  ]);
  const validate = createConversationAnnotationValidator({
    db,
    attachment: async (owner, id) => {
      const value = files.get(`${owner}:${id}`);
      if (!value) throw new Error("missing attachment");
      return { bytes: value, mimeType: "image/png" };
    },
    history: async (owner, threadId) => messages.get(`${owner}:${threadId}`) ?? [],
  });
  const annotations: AcceptedMessageInput["annotations"] = [
    {
      reference: { kind: "message" as const, messageId: "source", quote: "exact paragraph" },
      comment: "Please check this claim",
    },
    {
      reference: {
        kind: "attachment" as const,
        attachmentId: "file-a",
        version: digest(bytes),
        region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
      },
      comment: "The highlighted area matters",
    },
  ];
  try {
    await validate("owner", "chat", "first-message", ["file-a"], annotations);
    await assert.rejects(
      validate(
        "owner",
        "chat",
        "foreign-citation",
        ["file-a"],
        [{ ...annotations[0], reference: { kind: "message", messageId: "other-owner-message" } }],
      ),
      { status: 409 },
    );
    await assert.rejects(validate("owner", "chat", "missing-file", [], [annotations[1]]), {
      status: 422,
    });
    await assert.rejects(
      validate(
        "owner",
        "chat",
        "foreign-file",
        ["foreign-file"],
        [
          {
            reference: {
              kind: "attachment",
              attachmentId: "foreign-file",
              version: digest(new Uint8Array([9, 9, 9])),
            },
            comment: "This file belongs to another account",
          },
        ],
      ),
      { status: 409 },
    );
    await assert.rejects(
      validate(
        "owner",
        "chat",
        "stale-version",
        ["file-a"],
        [
          {
            reference: {
              kind: "attachment",
              attachmentId: "file-a",
              version: "old-version",
              region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
            },
            comment: "The highlighted area matters",
          },
        ],
      ),
      { status: 409 },
    );
    files.delete("owner:file-a");
    await assert.rejects(validate("owner", "chat", "removed-file", ["file-a"], [annotations[1]]), {
      status: 409,
    });
  } finally {
    await db.close();
  }
});

test("frame annotation is bound to the live masked frame and exact desktop generation", async () => {
  const db = await createStore();
  const desktopId = randomUUID();
  const generation = randomUUID();
  const frameId = randomUUID();
  const frame = {
    id: "executor:desktop",
    epoch: 1,
    operationId: randomUUID(),
    sessionId: desktopId,
    sessionGeneration: generation,
    sequence: 2,
    frameId,
    image: Buffer.from("desktop-frame-with-credential-fields-hidden").toString("base64"),
    mimeType: "image/png",
    width: 800,
    height: 600,
  };
  const validate = createConversationAnnotationValidator({
    db,
    attachment: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
    history: async () => [],
    desktopSession: async () => ({ id: desktopId, sessionGeneration: generation }),
    snapshotFrame: async (_owner, _threadId, _messageId, input) => {
      assert.equal(input.image, frame.image);
      assert.equal(
        Buffer.from(input.image, "base64").toString().includes("credential-canary"),
        false,
      );
      return { artifactId: "saved-masked-frame", version: "a".repeat(64) };
    },
  });
  const annotation = {
    reference: {
      kind: "frame" as const,
      frameId,
      sessionGeneration: generation,
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
    },
    comment: "This masked screen region is the issue",
  };
  try {
    await db.put("owner", "desktop-live-frames", frame);
    const accepted = await validate("owner", "chat", "annotated-frame", [], [annotation]);
    assert.deepEqual(
      accepted[0].reference.kind === "frame" && {
        snapshotArtifactId: accepted[0].reference.snapshotArtifactId,
        snapshotVersion: accepted[0].reference.snapshotVersion,
      },
      {
        snapshotArtifactId: "saved-masked-frame",
        snapshotVersion: "a".repeat(64),
      },
    );
    assert.equal(JSON.stringify(accepted).includes(frame.image), false);
    assert.equal(JSON.stringify(accepted).includes("credential-canary"), false);
    await db.put("owner", "desktop-live-frames", { ...frame, frameId: randomUUID(), sequence: 3 });
    await assert.rejects(validate("owner", "chat", "stale-frame", [], [annotation]), {
      status: 409,
    });
  } finally {
    await db.close();
  }
});
