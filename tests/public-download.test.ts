import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { PublicWeb, requestPublicAttachment } from "../apps/server/src/public-web.ts";

test("the pinned HTTP transport preserves non-text file bytes and decoded compression caps", async (t) => {
  const bytes = Buffer.from([0, 255, 128, 254, 71, 80, 0]);
  const expanded = Buffer.alloc(65536, 65);
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.accept, "*/*");
    if (req.url === "/large") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-encoding": "gzip",
      });
      res.end(gzipSync(expanded));
    } else if (req.url === "/pending") {
      res.writeHead(200);
      res.flushHeaders();
    } else {
      res.writeHead(200, { "content-type": "application/zip", "content-encoding": "gzip" });
      res.end(gzipSync(bytes));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  // Test the low-level pinned transport against a local fixture. PublicWeb's
  // destination policy is tested separately and never grants this address.
  const target = (path: string) => ({
    url: new URL(`http://files.invalid:${address.port}${path}`),
    address: "127.0.0.1",
    family: 4,
  });
  const result = await requestPublicAttachment(target("/file"), AbortSignal.timeout(2000), 4096);
  assert.deepEqual(result.bytes, bytes);
  await assert.rejects(
    requestPublicAttachment(target("/large"), AbortSignal.timeout(2000), 4096),
    /limit/i,
  );
  const abort = new AbortController();
  const pending = requestPublicAttachment(target("/pending"), abort.signal, 4096);
  void pending.catch(() => {});
  setTimeout(() => abort.abort(new Error("User stopped download")), 30);
  await assert.rejects(pending, /abort|stopped/i);
});

test("file downloads validate every redirect, including DNS resolution, before requesting bytes", async () => {
  const visited: string[] = [];
  const web = new PublicWeb({
    resolve: async (host) => [
      { address: host === "private.example" ? "10.0.0.1" : "93.184.216.34", family: 4 },
    ],
    requestBinary: async (target) => {
      visited.push(target.url.href);
      return {
        status: 302,
        headers: { location: "https://private.example/secret" },
        bytes: Buffer.alloc(0),
      };
    },
  });
  await assert.rejects(web.download("https://files.example/report.zip", 4096), /public HTTP/i);
  assert.deepEqual(visited, ["https://files.example/report.zip"]);
  for (const url of [
    "http://127.0.0.1/file",
    "https://user:pass@files.example/file",
    "http://169.254.169.254/file",
    "https://files.example:8080/file",
  ]) {
    await assert.rejects(web.download(url, 4096), /public HTTP/i);
  }
  assert.equal(visited.length, 1);
});

test("relative redirects retain actual binary content while invalid limits, size overflow and cancellation fail", async () => {
  let requests = 0;
  const bytes = Buffer.from([255, 254, 0, 128]);
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    requestBinary: async (target) => {
      requests++;
      return target.url.pathname === "/start"
        ? { status: 301, headers: { location: "/report.bin" }, bytes: Buffer.alloc(0) }
        : {
            status: 200,
            headers: { "content-type": "application/octet-stream; charset=utf-8" },
            bytes,
          };
    },
  });
  const result = await web.download("https://files.example/start", 100);
  assert.equal(result.url, "https://files.example/report.bin");
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.contentType, "application/octet-stream");
  for (const limit of [0, 0.5, 25 * 1024 * 1024 + 1])
    await assert.rejects(web.download("https://files.example/report.bin", limit), /cap/i);
  assert.equal(requests, 2);
  await assert.rejects(web.download("https://files.example/report.bin", 3), /exceeds/i);
  const abort = new AbortController();
  abort.abort(new Error("User stopped download"));
  await assert.rejects(
    web.download("https://files.example/report.bin", 100, abort.signal),
    /User stopped/i,
  );
  assert.equal(requests, 3);
});
