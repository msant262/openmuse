import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { SecretStore } from "../apps/server/src/credentials/contracts.ts";
import { createStore } from "../apps/server/src/db.ts";
import { parseMcpConfig } from "../apps/server/src/mcp.ts";
import { McpAuth } from "../apps/server/src/mcp-auth.ts";

async function fixture(t: TestContext) {
  const db = await createStore();
  t.after(() => db.close());
  const rows = new Map<string, { version: number; data: Record<string, string> }>();
  const vault: SecretStore = {
    read: async (owner, id) => structuredClone(rows.get(`${owner}:${id}`) ?? null),
    write: async (owner, id, data, previous) => {
      const key = `${owner}:${id}`;
      assert.equal(rows.get(key)?.version ?? 0, previous);
      rows.set(key, { version: previous + 1, data: { ...data } });
      return previous + 1;
    },
    delete: async (owner, id) => {
      rows.delete(`${owner}:${id}`);
    },
  };
  const servers = parseMcpConfig([
    {
      id: "portal",
      url: "https://mcp.test/mcp",
      tools: { read_notes: "read" },
      oauth: { authorizationOrigins: ["https://issuer.test"] },
    },
  ]);
  const calls: string[] = [];
  let exchanges = 0,
    refreshes = 0,
    now = Date.now(),
    hostile = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "mcp.test" && url.pathname.includes("oauth-protected-resource"))
      return Response.json({
        resource: "https://mcp.test/mcp",
        authorization_servers: [hostile ? "https://unconfigured.test" : "https://issuer.test"],
        scopes_supported: ["notes.read"],
      });
    if (url.pathname.includes("oauth-authorization-server"))
      return Response.json({
        issuer: "https://issuer.test",
        authorization_endpoint: "https://issuer.test/authorize",
        token_endpoint: "https://issuer.test/token",
        registration_endpoint: "https://issuer.test/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/register") {
      const request = JSON.parse(String(init?.body));
      return Response.json({ ...request, client_id: "fixture-client" });
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get("resource"), "https://mcp.test/mcp");
      if (params.get("grant_type") === "authorization_code") {
        exchanges++;
        assert.ok(params.get("code_verifier")!.length >= 43);
        assert.equal(params.get("redirect_uri"), "https://okami.tail.test/api/mcp/oauth/callback");
      } else {
        refreshes++;
        assert.equal(params.get("refresh_token"), "private-refresh-canary");
      }
      return Response.json({
        access_token: `private-access-canary-${exchanges + refreshes}`,
        refresh_token: "private-refresh-canary",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return new Response("", { status: 404 });
  };
  const broker = () =>
    new McpAuth(db, vault, servers, "https://okami.tail.test", { fetch: fetcher, now: () => now });
  return {
    db,
    vault,
    servers,
    broker,
    calls,
    hostile: () => (hostile = true),
    advance: () => (now += 3_600_000),
    exchanges: () => exchanges,
    refreshes: () => refreshes,
  };
}
test("OAuth discovers/registers, binds callback to one owner, stores PKCE/tokens only in vault and refreshes once", async (t) => {
  const f = await fixture(t),
    broker = f.broker();
  const start = await broker.start("owner", "portal");
  assert.ok(start.url);
  const url = new URL(start.url);
  assert.equal(url.origin, "https://issuer.test");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state")!;
  // The authorization can complete after the API restarts; no memory-only verifier.
  const restarted = f.broker();
  await restarted.callbackCode(state, "code-once");
  await assert.rejects(restarted.callbackCode(state, "code-once"), /already used/);
  assert.equal(f.exchanges(), 1);
  await assert.rejects(restarted.access("other-owner", f.servers[0]), /Connect this/);
  assert.equal(
    (await restarted.access("owner", f.servers[0])).headers.Authorization,
    "Bearer private-access-canary-1",
  );
  f.advance();
  const [one, two] = await Promise.all([
    restarted.access("owner", f.servers[0]),
    restarted.access("owner", f.servers[0]),
  ]);
  assert.deepEqual(one, two);
  assert.equal(f.refreshes(), 1);
  assert.equal(
    JSON.stringify(restarted.scrub({ returnedByTool: one.headers.Authorization })).includes(
      "private-access-canary",
    ),
    false,
  );
  const publicData = JSON.stringify({
    auth: await f.db.list("owner", "mcp-auth"),
    callbacks: await f.db.list("__oauth__", "mcp-callbacks"),
    status: await restarted.status("owner"),
  });
  for (const secret of ["private-refresh-canary", "private-access-canary", state, "code-once"])
    assert.equal(publicData.includes(secret), false);
  await restarted.disconnect("owner", "portal");
  await assert.rejects(restarted.access("owner", f.servers[0]), /Connect this/);
});
test("unconfigured discovery origin is never fetched; failed OAuth stays actionable without exposing provider text", async (t) => {
  const f = await fixture(t);
  f.hostile();
  await assert.rejects(f.broker().start("owner", "portal"), /could not authorize/);
  assert.equal(
    f.calls.some((url) => url.includes("unconfigured.test")),
    false,
  );
  assert.equal((await f.broker().status("owner"))[0].status, "needs_auth");
});
test("disconnect and newer flows invalidate pending callbacks before token exchange", async (t) => {
  const f = await fixture(t),
    broker = f.broker();
  const first = await broker.start("owner", "portal"),
    second = await broker.start("owner", "portal");
  await assert.rejects(
    broker.callbackCode(new URL(first.url!).searchParams.get("state")!, "old-code"),
    /changed/,
  );
  await broker.disconnect("owner", "portal");
  await assert.rejects(
    broker.callbackCode(new URL(second.url!).searchParams.get("state")!, "cancelled-code"),
    /changed/,
  );
  assert.equal(f.exchanges(), 0);
});
