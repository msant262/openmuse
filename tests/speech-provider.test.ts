import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { EdgeTTS } = require("node-edge-tts");
const sockets = require("ws");

test("an explicitly rejected speech handshake adjusts provider clock and retries once before sending text", async (t) => {
  let requests = 0;
  const providerDate = "Sun, 11 Oct 2026 00:20:00 GMT";
  t.mock.method(Date, "now", () => Date.parse("Sun, 11 Oct 2026 00:30:00 GMT"));
  class Socket extends EventEmitter {
    constructor(readonly url: string) {
      super();
      const attempt = ++requests;
      queueMicrotask(() => {
        if (attempt === 1) {
          const response = {
            statusCode: 403,
            headers: { date: providerDate },
            resume() {},
            destroy() {},
          };
          if (!this.emit("unexpected-response", { destroy() {} }, response))
            this.emit("error", new Error("Unexpected server response: 403"));
        } else this.emit("open");
      });
    }
    send() {}
  }
  t.mock.method(sockets, "WebSocket", Socket);
  const connection = await new EdgeTTS()._connectWebSocket();
  assert.equal(requests, 2);
  const url = new URL(connection.url);
  assert.ok(url.searchParams.get("ConnectionId"));
  // Independently derived from this RFC date's five-minute Windows epoch
  // window and the SDK's public client identifier, not its token helper.
  assert.equal(
    url.searchParams.get("Sec-MS-GEC"),
    "24AABB29D443966BCE6DC5B6B3F78CCDD785210AFCD7BCB0348D70F85C060A4D",
  );
});

test("a repeated 403 ends speech connection setup instead of looping", async (t) => {
  let requests = 0;
  class Socket extends EventEmitter {
    constructor() {
      super();
      requests++;
      queueMicrotask(() => {
        if (
          !this.emit(
            "unexpected-response",
            { destroy() {} },
            {
              statusCode: 403,
              headers: { date: new Date().toUTCString() },
              resume() {},
              destroy() {},
            },
          )
        )
          this.emit("error", new Error("Unexpected server response: 403"));
      });
    }
  }
  t.mock.method(sockets, "WebSocket", Socket);
  await assert.rejects(new EdgeTTS()._connectWebSocket(), /403/);
  assert.equal(requests, 2);
});
