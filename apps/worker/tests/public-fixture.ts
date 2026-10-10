/** Test-only socket transport. Production URL/DNS/proxy guards still run.
 * Only the synthetic public address is redirected to loopback servers; there
 * is no production switch that permits private browser destinations.
 */
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import dns from "node:dns/promises";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http, { type RequestListener } from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startEgressProxy } from "../src/proxy.ts";

export const fixtureOrigin = "https://browser.fixture.test";
const fixtureAddress = "93.184.216.34";
export type FixtureTransport = { httpPort: number; httpsPort: number; spki: string };

export function installFixtureTransport(config: FixtureTransport) {
  const lookup = dns.lookup;
  const request = http.request;
  const connect = net.connect;
  const persistent = chromium.launchPersistentContext;
  dns.lookup = (async (hostname: string, options?: { all?: boolean }) => {
    if (hostname !== "browser.fixture.test") throw new Error("Fixture rejects external DNS");
    const address = { address: fixtureAddress, family: 4 };
    return options?.all ? [address] : address;
  }) as typeof dns.lookup;
  http.request = ((...args: unknown[]) => {
    const options = args[0];
    if (
      options &&
      typeof options === "object" &&
      "hostname" in options &&
      options.hostname === fixtureAddress
    ) {
      if (!("port" in options) || Number(options.port) !== 80)
        throw new Error("Unexpected fixture HTTP port");
      args[0] = { ...options, hostname: "127.0.0.1", port: config.httpPort };
    }
    return Reflect.apply(request, http, args);
  }) as typeof http.request;
  net.connect = ((...args: unknown[]) => {
    const options = args[0];
    if (
      options &&
      typeof options === "object" &&
      "host" in options &&
      options.host === fixtureAddress
    ) {
      if (!("port" in options) || Number(options.port) !== 443)
        throw new Error("Unexpected fixture CONNECT port");
      args[0] = { ...options, host: "127.0.0.1", port: config.httpsPort };
    }
    return Reflect.apply(connect, net, args);
  }) as typeof net.connect;
  chromium.launchPersistentContext = (path, options = {}) =>
    persistent.call(chromium, path, {
      ...options,
      // Trust this test's short-lived certificate key only, not arbitrary TLS.
      args: [...(options.args ?? []), `--ignore-certificate-errors-spki-list=${config.spki}`],
    });
  syncBuiltinESMExports();
  return () => {
    dns.lookup = lookup;
    http.request = request;
    net.connect = connect;
    chromium.launchPersistentContext = persistent;
    syncBuiltinESMExports();
  };
}

export async function publicFixture() {
  const directory = await mkdtemp(join(tmpdir(), "okami-browser-fixture-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=browser.fixture.test",
      "-addext",
      "subjectAltName=DNS:browser.fixture.test",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  const key = await readFile(keyPath);
  const cert = await readFile(certPath);
  const spki = createHash("sha256")
    .update(createPublicKey(cert).export({ type: "spki", format: "der" }))
    .digest("base64");
  const requests: { path: string; secure: boolean }[] = [];
  const handler: RequestListener = (request, response) => {
    const path = request.url ?? "/";
    requests.push({ path, secure: "encrypted" in request.socket });
    if (path.startsWith("/redirect-private")) {
      response.writeHead(302, { location: "http://127.0.0.1:8790/health" });
      response.end();
    } else if (path === "/dialogs") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<title>Dialog fixture</title>
        <button onclick="document.querySelector('output').textContent = prompt('Name this document', 'Untitled') || 'Cancelled'">Name document</button>
        <button onclick="document.querySelector('output').textContent = confirm('Delete this document permanently?') ? 'Deleted' : 'Kept'">Delete document</button>
        <button onclick="alert('First notice'); alert('Second notice'); document.querySelector('output').textContent = 'Both notices acknowledged'">Two notices</button>
        <output>Unchanged</output>`);
    } else if (path === "/reviewed-dialog") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<title>Reviewed dialog fixture</title><button onclick="document.querySelector('output').textContent = confirm('Confirm payment of 10 euros?') ? 'Paid once' : 'Payment cancelled'">Pay 10 euros</button><output>Unchanged</output>`,
      );
    } else if (path === "/navigation-dialog") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<title>Navigation dialog</title><script>alert('Notice during navigation')</script><p>Loaded after notice</p>`,
      );
    } else if (path === "/diagnostics-flood") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<title>Bounded logs</title><script>for (let i = 0; i < 1005; i++) console.log('entry ' + i); console.log('x'.repeat(9000));</script>`,
      );
    } else if (path === "/diagnostics") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<title>Diagnostics fixture</title><main id="answer">Actual Chromium content</main><script>console.log('fixture log'); console.warn('fixture warning'); setTimeout(() => { throw new Error('fixture exception'); }, 10);</script>`,
      );
    } else if (path === "/protected-diagnostics") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<title>Protected fixture</title><input type="password" value="private-fixture-value">',
      );
    } else if (path === "/images") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<title>Image fixture</title><main><img src="/picture.svg" alt="Course cover"><img src="/picture.svg?second" alt="Second cover"><img src="data:image/svg+xml,%3Csvg/%3E" alt="Inline"><div data-openmuse-credential-sensitive="true"><img src="/picture.svg?private" alt="Protected credential image"></div><img src="/picture.svg?last" alt="Last cover"></main>`,
      );
    } else if (path.startsWith("/picture.svg")) {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>',
      );
    } else if (path === "/history") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<title>History fixture</title><button onclick="history.pushState({}, '', '#second')">Next section</button><p>Same document navigation</p>`,
      );
    } else if (path === "/json-results") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<title>Live count</title><main id="results">The count is being prepared.</main><script>fetch('/count.json').then(r=>r.json()).then(data=>document.getElementById('results').textContent='Votes: '+data.votes);</script>`,
      );
    } else if (path === "/count.json") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"votes":12345}');
      }, 1700);
    } else if (path === "/delayed-results") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Live results</title><main><h1>Live results</h1><div id="results" class="results-placeholder">Location 0</div></main><script>
        setTimeout(() => { const results = document.getElementById('results'); results.className = ''; results.textContent = 'Candidate A: 52% of 12345 votes'; }, 900);
      </script>`);
    } else if (path.startsWith("/upload")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>File fixture</title><label>Upload data<input type="file" id="file"></label><p id="received"></p>
        <a target="_blank" href="https://browser.fixture.test/other">Public popup</a>
        <a target="_blank" href="http://127.0.0.1/private">Private popup</a>
        <button id="dialog">Confirm</button><p id="confirmed"></p><script>
        document.getElementById('file').onchange=async e=>document.getElementById('received').textContent=await e.target.files[0].text();
        document.getElementById('dialog').onclick=()=>document.getElementById('confirmed').textContent=confirm('sensitive-dialog-fixture-marker')?'accepted':'dismissed';
        </script>`);
    } else if (path.startsWith("/download.csv")) {
      response.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="fixture.csv"',
      });
      response.end("name,value\nfixture,42\n");
    } else if (path.startsWith("/search")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        path.includes("unavailable")
          ? "<h1>Challenge required</h1>"
          : path.includes("empty")
            ? '<div class="no-results">No results</div>'
            : `
        <div class="result"><a class="result__a" href="http://127.0.0.1/private">Private</a><span class="result__snippet">must be discarded</span></div>
        <div class="result"><a class="result__a" href="https://browser.fixture.test/one">One</a><span class="result__snippet">First indexed snippet</span><time datetime="2026-10-03">Today</time></div>
        <div class="result"><a class="result__a" href="https://browser.fixture.test/two">Two</a><span class="result__snippet">${"Long snippet ".repeat(120)}</span></div>
        <div class="result"><a class="result__a" href="https://browser.fixture.test/three">Three</a><span class="result__snippet">Third</span></div>`,
      );
    } else if (path === "/large.txt") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Known fixture page. ".repeat(8_000));
    } else if (path === "/download.pdf") {
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="fixture.pdf"',
      });
      response.end("%PDF-1.4\nfixture download\n%%EOF\n");
    } else if (path === "/collect") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Submitted");
    } else {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><title>Browser fixture</title><h1>Local fixture content</h1><a href="/other">Next</a><a href="/download.pdf">Download</a><form action="/collect" method="post"><label>Name<input name="name"></label><button>Save</button></form>',
      );
    }
  };
  const httpServer = http.createServer(handler);
  const httpsServer = https.createServer({ key, cert }, handler);
  httpServer.listen(0, "127.0.0.1");
  httpsServer.listen(0, "127.0.0.1");
  await Promise.all([once(httpServer, "listening"), once(httpsServer, "listening")]);
  function port(server: http.Server) {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture failed to listen");
    return address.port;
  }
  const transport: FixtureTransport = {
    httpPort: port(httpServer),
    httpsPort: port(httpsServer),
    spki,
  };
  const restore = installFixtureTransport(transport);
  const proxy = await startEgressProxy();
  return {
    transport,
    requests,
    proxyUrl: proxy.url,
    async close() {
      await proxy.close();
      restore();
      for (const server of [httpServer, httpsServer]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
