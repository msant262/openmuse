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

test("native file search is discoverable, scoped and read-only, and rejects traversal before dispatch", async () => {
  const calls: unknown[] = [];
  let effects = 0;
  const backend = {
    search: async (owner: string, path: string, parameters: unknown) => {
      calls.push({ owner, path, parameters });
      return {
        results: [{ path: `${path}/budget.txt`, line: 2, content: "200 euros" }],
        complete: true,
      };
    },
  } as unknown as ComputerBackend;
  const tools = computerTools(backend, {} as never, "owner", "scope", {
    effectBefore: async () => {
      effects++;
    },
  });
  const tool = tools.find((tool) => tool.name === "search_files");
  assert.ok(tool);
  const execute = tool.execute as (input: unknown) => Promise<unknown>;
  await execute({ pattern: "budget", target: "files", path: "reports", limit: 20, offset: 2 });
  assert.deepEqual(calls, [
    {
      owner: "owner",
      path: "/workspace/reports",
      parameters: {
        pattern: "budget",
        target: "files",
        limit: 20,
        offset: 2,
        order: "discovery",
        output_mode: "content",
        context: 0,
      },
    },
  ]);
  const invalid = (await execute({ path: "../private", pattern: "*" })) as { status: string };
  assert.equal(invalid.status, "rejected_not_dispatched");
  assert.equal(calls.length, 1);
  assert.equal(effects, 0);
  assert.equal(
    computerTools({} as ComputerBackend, {} as never, "owner", "scope").some(
      (t) => t.name === "search_files",
    ),
    false,
    "do not advertise an unavailable backend",
  );
});
