import assert from "node:assert/strict";
import test from "node:test";
import { PublicWeb } from "../apps/server/src/public-web.ts";

test("large public JSON can be read in complete selected rows instead of discarding the data", async () => {
  const body = JSON.stringify({
    states: Array.from({ length: 27 }, (_, i) => ({
      uf: `UF${i}`,
      candidates: [
        { name: "A", percent: 51 },
        { name: "B", percent: 49 },
      ],
      geometry: "x".repeat(100000),
    })),
  });
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }),
  });
  const result = await web.readData("https://news.example/data.json", {
    pointer: "/states",
    select: ["/uf", "/candidates"],
    offset: 20,
    limit: 7,
  });
  assert.equal(result.total, 27);
  assert.equal(result.rows.length, 7);
  assert.equal(result.nextOffset, null);
  assert.deepEqual(result.rows[0], {
    "/uf": "UF20",
    "/candidates": [
      { name: "A", percent: 51 },
      { name: "B", percent: 49 },
    ],
  });
  assert.equal(result.truncated, false);
});

test("public data keeps URL validation and does not return partial oversized rows as complete", async () => {
  const web = new PublicWeb({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
  await assert.rejects(web.readData("http://private.example/data", {}));
});

test("HTTP reader decodes gzip JSON while enforcing the decompressed size limit", async (t) => {
  const { createServer } = await import("node:http");
  const { gzipSync } = await import("node:zlib");
  const { requestPublicPage } = await import("../apps/server/src/public-web.ts");
  const body = JSON.stringify({ rows: [{ state: "AC", percent: 51 }], padding: "x".repeat(5000) });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    res.end(gzipSync(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as import("node:net").AddressInfo).port;
  const target = {
    url: new URL(`http://fixture.example:${port}`),
    address: "127.0.0.1",
    family: 4 as const,
  };
  const response = await requestPublicPage(target, AbortSignal.timeout(3000), 10000);
  assert.equal(response.body, body);
  await assert.rejects(requestPublicPage(target, AbortSignal.timeout(3000), 1000), /limit/);
});

test("object-keyed datasets page as keyed rows and expose values for projection", async () => {
  const { selectPublicData } = await import("../apps/server/src/public-data.ts");
  const data = {
    states: { AC: { name: "Acre", percent: 52 }, AL: { name: "Alagoas", percent: 48 } },
  };
  const rows = selectPublicData(data, {
    pointer: "/states",
    entries: true,
    select: ["/key", "/value/percent"],
    limit: 10,
  });
  assert.deepEqual(rows.rows, [
    { "/key": "AC", "/value/percent": 52 },
    { "/key": "AL", "/value/percent": 48 },
  ]);
});

test("ordinary web reads expose the structure of large JSON instead of cutting through rows", async () => {
  const body = JSON.stringify({
    states: Array.from({ length: 27 }, (_, i) => ({
      uf: `UF${i}`,
      percent: 51,
      geometry: "x".repeat(2000),
    })),
  });
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }),
  });
  const result = await web.read("https://news.example/data.json");
  assert.equal(result.extraction.status, "partial");
  assert.match(result.extraction.reason ?? "", /read_web_data/);
  const preview = JSON.parse(result.text);
  assert.equal(preview.structure.states.length, 27);
  assert.deepEqual(preview.rows, []);
  const data = await web.readData(result.url, { pointer: "/states", select: ["/uf", "/percent"] });
  assert.equal(data.rows.length, 27);
  assert.equal(data.nextOffset, null);
});
