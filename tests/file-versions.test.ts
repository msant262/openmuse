import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { ExecutorRegistry } from "../apps/server/src/executors/registry.ts";
import { RemoteComputerBackend } from "../apps/server/src/executors/remote-computer.ts";
import { FileVersions } from "../apps/server/src/file-versions.ts";
import {
  authority,
  context,
  hello,
  readiness,
  registration,
  request,
} from "./helpers/executors.ts";

const artifactId = createHash("sha256").update("/workspace/file.bin").digest("hex");
const sha = createHash("sha256").update("before").digest("hex");
const artifact = {
  artifactId,
  path: "/workspace/file.bin",
  version: sha,
  sha256: sha,
  size: 6,
  mimeType: "application/octet-stream",
  executorLocal: true as const,
  published: false,
};

test("origin publication conflict rejects only its bound write or restore while inspection can publish a new generation", async () => {
  for (const kind of ["write", "restore"]) {
    const db = await createStore();
    try {
      const registry = new ExecutorRegistry(db, {
        registrations: [registration],
        authority: authority(db),
      });
      const { epoch } = await registry.register(hello);
      await registry.reconcile("lenovo-okami", {
        epoch,
        bootId: "boot-a",
        operations: [],
        contained: true,
      });
      await db.put("owner", "native-artifacts", {
        id: artifactId,
        executorId: "lenovo-okami",
        ...artifact,
        published: true,
      });
      await db.put("owner", "file-versions", {
        id: "restore-original",
        executorId: "lenovo-okami",
        artifactId,
        path: artifact.path,
        sha256: sha,
        size: 6,
        createdAt: 1720000000,
        trashed: false,
        retentionDays: 30,
      });
      const native = new RemoteComputerBackend(registry, {
        executorId: "lenovo-okami",
        context: async () => context,
        pollMs: 1,
        fileWaitMs: 200,
      });
      const versions = new FileVersions(registry, { pollMs: 1, receiptWaitMs: 200 });
      const result =
        kind === "write"
          ? native.write("owner", artifact.path, "before")
          : versions.restore("owner", "restore-original", sha, "restore-conflicted", context);
      const rejection = assert.rejects(result, /publication.*conflict/i);
      const batch = await registry.claimOperations("lenovo-okami", epoch, { waitMs: 500 });
      assert.ok(batch.operations[0]);
      const pending = {
        ...artifact,
        generation: 2,
        versionId: "4370cfaf-c95b-4e35-931a-6b7da7907a5f",
      };
      await registry.submitReceipt("lenovo-okami", epoch, batch.operations[0].id, 1, {
        status: "succeeded",
        data: pending,
      });
      await registry.heartbeat("lenovo-okami", epoch, {
        ...readiness,
        publicationConflicts: [
          {
            artifactId,
            path: artifact.path,
            version: sha,
            sha256: sha,
            generation: 2,
            versionId: pending.versionId,
            reason: "Origin modified before publication ACK",
            observedAt: 1720000000,
          },
        ],
      });
      await rejection;
      await assert.rejects(registry.publishArtifact("lenovo-okami", epoch, pending), /conflict/i);
      const inspected = {
        ...artifact,
        generation: 3,
        versionId: "b883fc93-d99c-4693-aa78-54704a87bfa0",
        version: "b".repeat(64),
        sha256: "b".repeat(64),
      };
      const inspect = await registry.enqueue(
        "owner",
        {
          ...request("b".repeat(64)),
          kind: "file",
          capability: "files",
          inspection: true,
          args: { operation: "stat", path: artifact.path },
        },
        context,
      );
      assert.equal(
        (await registry.claimOperations("lenovo-okami", epoch)).operations[0]?.id,
        inspect.id,
      );
      await registry.submitReceipt("lenovo-okami", epoch, inspect.id, 1, {
        status: "succeeded",
        data: inspected,
      });
      await registry.publishArtifact("lenovo-okami", epoch, inspected);
      assert.equal(
        (await db.get<{ generation: number }>("owner", "native-artifacts", artifactId))?.generation,
        3,
      );
      assert.equal(
        (await registry.delivery("owner", batch.operations[0].id))?.receipt?.status,
        "succeeded",
      );
    } finally {
      await db.close();
    }
  }
});

test("a lost publication ACK invalidates matching metadata while conflicts remain hash and generation bound", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const op = await registry.enqueue(
      "owner",
      {
        ...request(),
        kind: "file",
        capability: "files",
        args: { operation: "write_binary", path: artifact.path },
      },
      context,
    );
    await registry.claimOperations("lenovo-okami", epoch);
    const pending = {
      ...artifact,
      generation: 2,
      versionId: "4370cfaf-c95b-4e35-931a-6b7da7907a5f",
    };
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 1, {
      status: "succeeded",
      data: pending,
    });
    await registry.publishArtifact("lenovo-okami", epoch, pending);
    const conflict = {
      artifactId,
      path: artifact.path,
      version: sha,
      sha256: sha,
      generation: 2,
      versionId: pending.versionId,
      reason: "Origin changed while publication ACK was lost",
      observedAt: 1720000000,
    };
    await registry.heartbeat("lenovo-okami", epoch, {
      ...readiness,
      publicationConflicts: [{ ...conflict, sha256: "c".repeat(64) }],
    });
    assert.equal(
      (await db.get<{ published: boolean }>("owner", "native-artifacts", artifactId))?.published,
      true,
    );
    await registry.heartbeat("lenovo-okami", epoch, {
      ...readiness,
      publicationConflicts: [conflict],
    });
    assert.equal(
      (await db.get<{ published: boolean }>("owner", "native-artifacts", artifactId))?.published,
      false,
    );
    await assert.rejects(registry.publishArtifact("lenovo-okami", epoch, pending), /conflict/i);
    assert.ok(await registry.publicationConflict("owner", "lenovo-okami", pending));
    assert.equal(
      await registry.publicationConflict("owner", "lenovo-okami", { ...pending, generation: 3 }),
      null,
    );
  } finally {
    await db.close();
  }
});

test("native publication requires owned hash/version proof and generic binary MIME remains valid", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    await assert.rejects(registry.publishArtifact("lenovo-okami", epoch, artifact), /proof/);
    const op = await registry.enqueue(
      "owner",
      {
        ...request(),
        kind: "file",
        capability: "files",
        args: { operation: "write_binary", path: "/workspace/file.bin" },
      },
      context,
    );
    await registry.claimOperations("lenovo-okami", epoch);
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 1, {
      status: "succeeded",
      data: artifact,
    });
    assert.deepEqual(await registry.publishArtifact("lenovo-okami", epoch, artifact), {
      artifactId,
      version: sha,
      sha256: sha,
    });
    assert.equal(
      (await db.get<{ mimeType: string }>("owner", "native-artifacts", artifactId))?.mimeType,
      "application/octet-stream",
    );
    await assert.rejects(
      registry.publishArtifact("lenovo-okami", epoch, { ...artifact, sha256: "0".repeat(64) }),
      /proof/,
    );
    await assert.rejects(registry.deliveries("other-owner", "lenovo-okami"), /owner/);
  } finally {
    await db.close();
  }
});

test("recover metadata is owner scoped, journal IDs dedupe and offline restore never invents success", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    await registry.register(hello);
    await db.put("owner", "native-artifacts", {
      id: artifactId,
      executorId: "lenovo-okami",
      ...artifact,
      published: true,
    });
    await db.put("owner", "file-versions", {
      id: "a5233ea7-f13f-4538-b922-fceca38823fb",
      executorId: "lenovo-okami",
      artifactId,
      path: "/workspace/file.bin",
      sha256: sha,
      size: 6,
      createdAt: 1720000000,
      trashed: false,
      retentionDays: 30,
    });
    const versions = new FileVersions(registry, { pollMs: 1, receiptWaitMs: 20 });
    assert.equal((await versions.list("owner")).versions.length, 1);
    assert.deepEqual((await versions.list("other-owner")).versions, []);
    await assert.rejects(
      versions.restore("other-owner", "a5233ea7-f13f-4538-b922-fceca38823fb", sha, "req", context),
      /not found/i,
    );
    await assert.rejects(
      versions.restore("owner", "a5233ea7-f13f-4538-b922-fceca38823fb", sha, "req", context),
      /pending|offline|reconcil/i,
    );
    await assert.rejects(
      versions.restore("owner", "a5233ea7-f13f-4538-b922-fceca38823fb", sha, "req", context),
      /pending|offline|reconcil/i,
    );
    assert.equal((await registry.deliveries("owner", "lenovo-okami")).length, 1);
    const metadata = await versions.list("owner");
    assert.equal(metadata.policy.retentionDays, 30);
    assert.equal(metadata.policy.maxVersionBytes, 2 * 1024 ** 3);
    assert.equal(metadata.policy.scope, "controlled-tools");
  } finally {
    await db.close();
  }
});

test("restore waits for acknowledged origin artifact and reports conflict-copy metadata", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    await db.put("owner", "native-artifacts", {
      id: artifactId,
      executorId: "lenovo-okami",
      ...artifact,
      published: true,
    });
    await db.put("owner", "file-versions", {
      id: "version-one",
      executorId: "lenovo-okami",
      artifactId,
      path: artifact.path,
      sha256: sha,
      size: 6,
      createdAt: 1720000000,
      trashed: false,
      retentionDays: 30,
    });
    const versions = new FileVersions(registry, { pollMs: 1, receiptWaitMs: 3000 });
    const promise = versions.restore(
      "owner",
      "version-one",
      "f".repeat(64),
      "restore-request",
      context,
    );
    let batch = await registry.claimOperations("lenovo-okami", epoch, { waitMs: 500 });
    if (!batch.operations.length)
      batch = await registry.claimOperations("lenovo-okami", epoch, { waitMs: 500 });
    const op = batch.operations[0];
    assert.ok(op);
    const recoveredPath = "/workspace/file-recovered-a.bin";
    const recovered = {
      ...artifact,
      artifactId: createHash("sha256").update(recoveredPath).digest("hex"),
      path: recoveredPath,
      restoredAsCopy: true,
    };
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 1, {
      status: "succeeded",
      data: recovered,
    });
    await registry.publishArtifact("lenovo-okami", epoch, recovered);
    assert.equal((await promise).restoredAsCopy, true);
    assert.equal((await versions.list("owner")).artifacts.length, 2);
  } finally {
    await db.close();
  }
});

test("delayed artifact publication cannot replace a newer acknowledged generation", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    for (const generation of [2, 1]) {
      const version = generation === 2 ? "a".repeat(64) : sha;
      const publication = { ...artifact, generation, version, sha256: version };
      const op = await registry.enqueue(
        "owner",
        {
          ...request(String(generation).repeat(64)),
          kind: "file",
          capability: "files",
          args: { operation: "write_binary", path: artifact.path },
        },
        context,
      );
      await registry.claimOperations("lenovo-okami", epoch);
      await registry.submitReceipt("lenovo-okami", epoch, op.id, 1, {
        status: "succeeded",
        data: publication,
      });
      await registry.publishArtifact("lenovo-okami", epoch, publication);
    }
    assert.equal(
      (
        await db.get<{ generation: number; version: string }>(
          "owner",
          "native-artifacts",
          artifactId,
        )
      )?.generation,
      2,
    );
  } finally {
    await db.close();
  }
});

test("controlled native binary write waits for hash/generation ACK and malformed metadata cannot partially publish", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    await registry.reconcile("lenovo-okami", {
      epoch,
      bootId: "boot-a",
      operations: [],
      contained: true,
    });
    const native = new RemoteComputerBackend(registry, {
      executorId: "lenovo-okami",
      context: async () => context,
      pollMs: 1,
    });
    let announced = false;
    const write = native
      .writeBytes("owner", artifact.path, new TextEncoder().encode("before"))
      .then((value) => {
        announced = true;
        return value;
      });
    const batch = await registry.claimOperations("lenovo-okami", epoch, { waitMs: 1000 });
    const op = batch.operations[0];
    assert.ok(op);
    assert.equal(op.args.base64, Buffer.from("before").toString("base64"));
    const publication = {
      ...artifact,
      generation: 1,
      versionId: "8ed27c19-8116-4a58-9fc3-e6aa6ae7a5f2",
    };
    await registry.submitReceipt("lenovo-okami", epoch, op.id, 1, {
      status: "succeeded",
      data: publication,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(announced, false);
    await assert.rejects(
      registry.publishArtifact("lenovo-okami", epoch, { ...publication, generation: 2 }),
      /proof/,
    );
    await assert.rejects(
      registry.publishArtifact("lenovo-okami", epoch, {
        ...publication,
        versions: [
          {
            id: "bad-version",
            artifactId,
            path: "/workspace/other",
            sha256: sha,
            size: 6,
            createdAt: 1,
            trashed: false,
            retentionDays: 30,
          },
        ],
      }),
      /owned/,
    );
    assert.equal(await db.get("owner", "native-artifacts", artifactId), null);
    assert.deepEqual(await db.list("owner", "file-versions"), []);
    const ack = await registry.publishArtifact("lenovo-okami", epoch, publication);
    assert.equal(ack.versionId, publication.versionId);
    assert.equal(ack.generation, 1);
    await write;
    assert.equal(announced, true);
  } finally {
    await db.close();
  }
});

test("bounded conflict batches are acknowledged only after durable invalidation and replay after lost ACK", async () => {
  const db = await createStore();
  try {
    const registry = new ExecutorRegistry(db, {
      registrations: [registration],
      authority: authority(db),
    });
    const { epoch } = await registry.register(hello);
    const conflicts = Array.from({ length: 101 }, (_, index) => ({
      artifactId: createHash("sha256").update(`conflict-${index}`).digest("hex"),
      path: `/workspace/f${index}.txt`,
      version: sha,
      sha256: sha,
      generation: 1,
      reason: "Origin changed after server publication but before ACK",
      observedAt: 1720000000,
    }));
    for (const conflict of conflicts)
      await db.put("owner", "native-artifacts", {
        ...conflict,
        id: conflict.artifactId,
        executorId: "lenovo-okami",
        published: true,
      });
    const first = conflicts.slice(0, 100);
    const delivered = await registry.heartbeat("lenovo-okami", epoch, {
      ...readiness,
      publicationConflicts: first,
    });
    assert.deepEqual(delivered.publicationConflictAcks, first);
    const replay = await registry.heartbeat("lenovo-okami", epoch, {
      ...readiness,
      publicationConflicts: first,
    });
    assert.deepEqual(replay.publicationConflictAcks, first);
    const last = conflicts.slice(100);
    const final = await registry.heartbeat("lenovo-okami", epoch, {
      ...readiness,
      publicationConflicts: last,
    });
    assert.deepEqual(final.publicationConflictAcks, last);
    for (const conflict of conflicts) {
      assert.ok(await registry.publicationConflict("owner", "lenovo-okami", conflict));
      assert.equal(
        (await db.get<{ published: boolean }>("owner", "native-artifacts", conflict.artifactId))
          ?.published,
        false,
      );
    }
    const broken = { ...conflicts[0], generation: 2 };
    const insert = db.insertIfAbsent.bind(db);
    db.insertIfAbsent = async (owner, collection, value) => {
      if (collection === "native-artifact-conflicts") throw new Error("durability unavailable");
      return insert(owner, collection, value);
    };
    await assert.rejects(
      registry.heartbeat("lenovo-okami", epoch, { ...readiness, publicationConflicts: [broken] }),
      /durability unavailable/,
    );
    db.insertIfAbsent = insert;
    assert.equal(await registry.publicationConflict("owner", "lenovo-okami", broken), null);
  } finally {
    await db.close();
  }
});
