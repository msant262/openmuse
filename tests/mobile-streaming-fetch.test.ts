import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const root = dirname(require.resolve("@copilotkit/react-native/package.json"));

for (const file of ["streaming-fetch-BTESzLKX.cjs", "streaming-fetch-BnQh3vBz.mjs"]) {
  test(`native fetch accepts DONE-only HTTP responses and rejects status zero (${file})`, async () => {
    const source = (await readFile(join(root, "dist", file), "utf8")).replace(
      "export { installStreamingFetch as t };",
      "exports.installStreamingFetch = installStreamingFetch;",
    );
    for (const [states, status] of [
      [[2, 4], 200],
      [[4], 200],
      [[4], 429],
      [[4], 0],
    ] as const) {
      class FakeXHR {
        readyState = 0;
        status = status;
        statusText = status === 200 ? "OK" : "Unavailable";
        responseText = '{"received":true}';
        onreadystatechange = () => {};
        onload = () => {};
        open() {}
        setRequestHeader() {}
        getAllResponseHeaders() {
          return "content-type: application/json";
        }
        abort() {}
        send() {
          for (const state of states) {
            this.readyState = state;
            this.onreadystatechange();
          }
          this.onload();
        }
      }
      const context = {
        exports: {} as { installStreamingFetch: () => void },
        global: undefined as unknown,
        Response: class {
          body = null;
        },
        XMLHttpRequest: FakeXHR,
        fetch: undefined as unknown as typeof fetch,
        Headers,
        URL,
        TextEncoder,
        ReadableStream,
        DOMException,
        setTimeout,
        __DEV__: false,
      };
      context.global = context;
      runInNewContext(source, context);
      context.exports.installStreamingFetch();
      if (status === 0) {
        await assert.rejects(context.fetch("https://fixture.invalid/main"), /status 0/);
      } else {
        const response = await context.fetch("https://fixture.invalid/main");
        assert.equal(response.status, status);
        assert.equal(response.ok, status === 200);
        assert.equal((await response.json()).received, true);
      }
    }
  });
}
