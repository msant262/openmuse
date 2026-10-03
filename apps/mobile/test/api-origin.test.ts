import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveApiOrigin } from "../src/api-origin.ts";

test("one hosted web artifact uses its public or private HTTPS origin despite a stale build URL", () => {
  for (const pageOrigin of ["https://app.example.com", "https://node.example.ts.net"]) {
    assert.equal(
      resolveApiOrigin({
        platform: "web",
        configured: "http://localhost:8787",
        sameOrigin: true,
        pageOrigin,
      }),
      pageOrigin,
    );
  }
});

test("native and separate-origin development keep their explicit API URL", () => {
  assert.equal(
    resolveApiOrigin({
      platform: "android",
      configured: "https://app.example.com",
      sameOrigin: true,
    }),
    "https://app.example.com",
  );
  assert.equal(
    resolveApiOrigin({
      platform: "web",
      configured: "http://localhost:8787",
      pageOrigin: "http://localhost:8081",
    }),
    "http://localhost:8787",
  );
});

test("same-origin mode rejects a missing or unsafe browser origin", () => {
  for (const pageOrigin of [
    undefined,
    "null",
    "file:///tmp/index.html",
    "https://user:password@example.com",
  ]) {
    assert.throws(() => resolveApiOrigin({ platform: "web", sameOrigin: true, pageOrigin }));
  }
});
