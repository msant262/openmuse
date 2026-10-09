import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComputerBackend } from "../apps/server/src/computer-contract.ts";
import { computerTools } from "../apps/server/src/computer-tools.ts";

test("workspace file tools resolve a relative filename without changing its contents", async () => {
  const calls: unknown[] = [];
  const backend = {
    write: async (owner: string, path: string, text: string) => {
      calls.push({ owner, path, text });
      return { path, written: true };
    },
  } as unknown as ComputerBackend;
  const tools = computerTools(backend, {} as never, "owner", "scope");
  for (const name of ["write_file", "write_computer_file"]) {
    const tool = tools.find((tool) => tool.name === name)!;
    await (tool.execute as (input: unknown) => Promise<unknown>)({
      path: "results/primes.txt",
      text: "2, 3, 5\n",
    });
  }
  assert.deepEqual(
    calls,
    Array(2).fill({
      owner: "owner",
      path: "/workspace/results/primes.txt",
      text: "2, 3, 5\n",
    }),
  );
});

test("invalid file paths are rejected before effect authorization and remain safely correctable", async () => {
  let authorizations = 0,
    writes = 0;
  const tools = computerTools(
    {
      write: async () => {
        writes++;
      },
    } as unknown as ComputerBackend,
    {} as never,
    "owner",
    "scope",
    {
      effectBefore: async () => {
        authorizations++;
      },
    },
  );
  const tool = tools.find((tool) => tool.name === "write_file")!;
  for (const path of ["../outside.txt", "/etc/file", "/workspace/../file", "/workspace", "a\0b"]) {
    const result = (await (tool.execute as (input: unknown) => Promise<unknown>)({
      path,
      text: "value",
    })) as {
      status: string;
      dispatched: boolean;
    };
    assert.equal(result.status, "rejected_not_dispatched", path);
    assert.equal(result.dispatched, false, path);
  }
  assert.equal(authorizations, 0);
  assert.equal(writes, 0);
});
