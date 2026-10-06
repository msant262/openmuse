import assert from "node:assert/strict";
import test from "node:test";
import { selectPublicData } from "../apps/server/src/public-data.ts";
import { PublicWeb } from "../apps/server/src/public-web.ts";

test("invalid data pointers expose observed field paths and root syntax without returning source values", () => {
  const source = {
    records: [{ name: "Example", votes: 12 }],
    "source/name": "This source value must not appear in a pointer diagnostic",
  };
  for (const path of ["/", "/invented"]) {
    assert.throws(
      () => selectPublicData(source, { pointer: path }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /pointer=""/);
        assert.match(error.message, /\/records \(array\)/);
        assert.match(error.message, /\/source~1name \(string\)/);
        assert.doesNotMatch(error.message, /This source value/);
        return true;
      },
    );
  }
  assert.throws(
    () => selectPublicData(source, { pointer: "/records", select: ["votes"] }),
    /Use \/votes/,
  );
  assert.deepEqual(selectPublicData(source, { pointer: "/records", select: ["/votes"] }).rows, [
    { "/votes": 12 },
  ]);
});

test("object-key aggregation identifies the missing entries mode and observed fields", () => {
  const source = { north: { votes: 12 }, south: { votes: 8 } };
  const aggregate = {
    groupBy: [{ name: "region", pointer: "/key" }],
    sum: [{ name: "votes", pointer: "/value/votes" }],
  };
  assert.throws(
    () => selectPublicData(source, { aggregate }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /entries=true/);
      assert.match(error.message, /\/north \(object\)/);
      return true;
    },
  );
  assert.deepEqual(selectPublicData(source, { entries: true, aggregate }).rows, [
    { region: "north", count: 1, votes: 12 },
    { region: "south", count: 1, votes: 8 },
  ]);
});

test("an expanded dataset explains how to repair a grouping pointer without returning partial totals", () => {
  const source = {
    regionA: {
      items: [
        { name: "X", votes: 5 },
        { name: "Y", votes: 4 },
      ],
    },
  };
  const query = {
    entries: true,
    aggregate: {
      expand: "/value/items",
      groupBy: [{ name: "region", pointer: "/key" }],
      sum: [{ name: "votes", pointer: "/item/votes" }],
    },
  };
  assert.throws(() => selectPublicData(source, query), /\/parent\/key/);
  const repaired = selectPublicData(source, {
    ...query,
    aggregate: { ...query.aggregate, groupBy: [{ name: "region", pointer: "/parent/key" }] },
  });
  assert.deepEqual(repaired.rows, [{ region: "regionA", count: 2, votes: 9 }]);
});

test("public data aggregation includes every source row and locale-formatted number", async () => {
  const body = JSON.stringify({
    locations: Object.fromEntries(
      Array.from({ length: 5572 }, (_, i) => [
        `${i % 2 ? "22" : "11"}${String(i).padStart(5, "0")}`,
        {
          candidates: [
            { name: "A", votes: "1.234" },
            { name: "B", votes: "766" },
          ],
        },
      ]),
    ),
  });
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }),
  });
  const result = await web.readData("https://source.example/data.json", {
    pointer: "/locations",
    entries: true,
    limit: 100,
    aggregate: {
      expand: "/value/candidates",
      groupBy: [
        { name: "state", pointer: "/parent/key", prefix: 2 },
        { name: "candidate", pointer: "/item/name" },
      ],
      sum: [{ name: "votes", pointer: "/item/votes", numberFormat: "pt-BR" }],
    },
  });
  assert.equal(result.total, 4);
  assert.deepEqual(result.rows, [
    { state: "11", candidate: "A", count: 2786, votes: 2786 * 1234 },
    { state: "11", candidate: "B", count: 2786, votes: 2786 * 766 },
    { state: "22", candidate: "A", count: 2786, votes: 2786 * 1234 },
    { state: "22", candidate: "B", count: 2786, votes: 2786 * 766 },
  ]);
  assert.equal(result.aggregation?.inputRows, 5572);
  assert.equal(result.aggregation?.expandedRows, 11144);
  assert.equal(result.nextOffset, null);
});

test("shares include all categories before filtering and invalid numbers never yield partial totals", async () => {
  const { selectPublicData } = await import("../apps/server/src/public-data.ts");
  const aggregate = {
    groupBy: [
      { name: "region", pointer: "/region" },
      { name: "candidate", pointer: "/candidate" },
    ],
    sum: [{ name: "votes", pointer: "/votes", numberFormat: "pt-BR" as const }],
    share: { of: "votes", within: ["region"], name: "percent" },
  };
  const rows = [
    { region: "A", candidate: "X", votes: "40" },
    { region: "A", candidate: "Y", votes: "30" },
    { region: "A", candidate: "Z", votes: "30" },
  ];
  assert.deepEqual(
    selectPublicData(rows, { aggregate, where: { pointer: "/candidate", oneOf: ["X", "Y"] } }).rows,
    [
      { region: "A", candidate: "X", count: 1, votes: 40, percent: 40 },
      { region: "A", candidate: "Y", count: 1, votes: 30, percent: 30 },
    ],
  );
  assert.throws(
    () =>
      selectPublicData([...rows, { region: "A", candidate: "X", votes: "unknown" }], { aggregate }),
    /invalid number/,
  );
  assert.throws(
    () =>
      selectPublicData(rows, {
        aggregate: { ...aggregate, sum: [{ name: "region", pointer: "/votes" }] },
      }),
    /unique/,
  );
});

test("compact JWS datasets expose their JSON payload without claiming signature verification", async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "EdDSA", typ: "JOSE" })}.${encode({
    states: [
      { uf: "AC", percent: 52 },
      { uf: "AL", percent: 48 },
    ],
    padding: "x".repeat(32000),
  })}.c2lnbmF0dXJl`;
  const web = new PublicWeb({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }),
  });
  const page = await web.read("https://official.example/results.jws");
  assert.match(page.text, /states/);
  assert.ok("signatureVerified" in page.provenance);
  assert.equal(page.provenance.signatureVerified, false);
  const result = await web.readData(page.url, { pointer: "/states", select: ["/uf", "/percent"] });
  assert.deepEqual(result.rows, [
    { "/uf": "AC", "/percent": 52 },
    { "/uf": "AL", "/percent": 48 },
  ]);
  assert.equal(result.encoding, "jws");
  assert.equal(result.signatureVerified, false);
});

test("malformed or unencoded compact payloads remain unreadable instead of accepting decoded fragments", async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const body of [
    `${encode({ alg: "EdDSA", b64: false })}.${encode({ value: 1 })}.c2ln`,
    `${encode({ alg: "EdDSA" })}.bm90LWpzb24.c2ln`,
  ]) {
    const web = new PublicWeb({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }),
    });
    await assert.rejects(web.readData("https://official.example/results.jws"), /valid JSON/);
  }
});

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

test("an oversized keyed dataset remains recoverable through entries and complete aggregation", async () => {
  const { selectPublicData } = await import("../apps/server/src/public-data.ts");
  const data = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [String(i), { amount: i + 1, notes: "x".repeat(150) }]),
  );
  const initial = selectPublicData(data);
  assert.deepEqual(initial.rows, []);
  assert.equal(initial.truncated, true);
  assert.match(initial.instruction ?? "", /entries=true/);
  const sample = selectPublicData(data, { entries: true, limit: 2 });
  assert.equal(sample.total, 200);
  assert.equal(sample.rows.length, 2);
  const totals = selectPublicData(data, {
    entries: true,
    aggregate: { groupBy: [], sum: [{ name: "amount", pointer: "/value/amount" }] },
  });
  assert.deepEqual(totals.rows, [{ count: 200, amount: 20100 }]);
  assert.equal(totals.truncated, false);
});

test("ordinary web reads preserve source JSON values and expose its complete structure", async () => {
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
  assert.ok("structure" in result);
  assert.equal((result.structure as { states: { length: number } }).states.length, 27);
  assert.match(result.text, /"uf": "UF0"/);
  assert.match(result.text, /"percent": 51/);
  assert.equal(result.text.length, 30000);
  const data = await web.readData(result.url, { pointer: "/states", select: ["/uf", "/percent"] });
  assert.equal(data.rows.length, 27);
  assert.equal(data.nextOffset, null);
});
