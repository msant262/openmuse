import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

test("native desktop rejects stale input, releases revoked gestures and isolates its session", async () => {
  const result = await promisify(execFile)(
    "python3",
    ["-m", "unittest", "discover", "-s", "apps/computer/desktop", "-p", "test_*.py"],
    {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONPATH: resolve("apps/computer") },
    },
  );
  assert.match(result.stderr, /Ran [1-9]\d* tests/);
  assert.match(result.stderr, /OK/);
});
