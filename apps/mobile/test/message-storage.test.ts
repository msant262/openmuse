import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { MessageStorage } from "../src/message-storage.ts";

async function nativeStorageFixture() {
  const files = new Map<string, string>();
  const inaccessible = new Set<string>();
  let tearNextWrite = false;
  class Directory {
    create() {}
  }
  class File {
    constructor(
      _directory: Directory,
      readonly name: string,
    ) {}
    get exists() {
      return files.has(this.name);
    }
    create() {
      files.set(this.name, "");
    }
    write(value: string) {
      if (tearNextWrite) {
        tearNextWrite = false;
        files.set(this.name, "{torn");
        throw new Error("Interrupted file write");
      }
      files.set(this.name, value);
    }
    textSync() {
      if (inaccessible.has(this.name)) throw new Error("File inaccessible");
      return files.get(this.name)!;
    }
  }
  const source = await readFile(
    new URL("../src/message-storage.native.ts", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { messageStorage?: MessageStorage } = {};
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      if (name === "expo-file-system") return { Directory, File, Paths: { document: "/fixture" } };
      if (name === "./message-hash")
        return { sha256: (value: string) => createHash("sha256").update(value).digest("hex") };
      throw new Error(`Unexpected fixture import ${name}`);
    },
  });
  return {
    storage: exports.messageStorage!,
    files,
    inaccessible,
    tearWrite: () => {
      tearNextWrite = true;
    },
  };
}

test("native generations recover a torn write and serialize mounted shared-key writers", async () => {
  const fixture = await nativeStorageFixture();
  const { storage } = fixture;
  assert.equal(await storage.read("chat"), null);
  await Promise.all([
    storage.update("chat", (raw) => JSON.stringify([...(raw ? JSON.parse(raw) : []), "one"])),
    storage.update("chat", (raw) => JSON.stringify([...(raw ? JSON.parse(raw) : []), "two"])),
  ]);
  assert.deepEqual(JSON.parse((await storage.read("chat"))!), ["one", "two"]);
  fixture.tearWrite();
  await assert.rejects(
    storage.update("chat", () => '["unconfirmed"]'),
    /Interrupted file write/,
  );
  assert.deepEqual(JSON.parse((await storage.read("chat"))!), ["one", "two"]);
});

test("native corrupt or inaccessible data cannot be mistaken for an empty outbox", async () => {
  const fixture = await nativeStorageFixture();
  await fixture.storage.write("chat", "confirmed-one");
  await fixture.storage.write("chat", "confirmed-two");
  const names = [...fixture.files.keys()];
  fixture.inaccessible.add(names[0]);
  await assert.rejects(fixture.storage.read("chat"), /inaccessible/);
  await assert.rejects(
    fixture.storage.update("chat", () => "replacement"),
    /inaccessible/,
  );
  fixture.inaccessible.clear();
  for (const name of names) fixture.files.set(name, "{damaged");
  await assert.rejects(fixture.storage.read("chat"), /damaged/);
  await assert.rejects(fixture.storage.write("chat", "replacement"), /damaged/);
  assert.ok([...fixture.files.values()].every((value) => value === "{damaged"));
});
