import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import type { SecretStore } from "../apps/server/src/credentials/contracts.ts";
import { createStore } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import {
  ConnectedSearchBackend,
  IntegrationService,
  integrationRoutes,
  integrationTools,
} from "../apps/server/src/integrations.ts";
import { searchResultSchema } from "../packages/domain/src/search.ts";

const canary = "tvly-test-DO-NOT-PERSIST-7a40eb";
function vaultFixture() {
  const values = new Map<string, { version: number; data: Record<string, string> }>();
  const vault: SecretStore = {
    async read(owner, id) {
      return values.get(`${owner}:${id}`) ?? null;
    },
    async write(owner, id, data, expected) {
      const key = `${owner}:${id}`;
      assert.equal(values.get(key)?.version ?? 0, expected);
      const version = expected + 1;
      values.set(key, { version, data });
      return version;
    },
    async delete(owner, id) {
      values.delete(`${owner}:${id}`);
    },
  };
  return { vault, values };
}
test("Tavily secure card survives reconnect, stays owner-scoped, and automatically powers search without disclosing secrets", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const { vault, values } = vaultFixture();
  const calls: string[] = [];
  const service = new IntegrationService(db, vault, {
    available: true,
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${canary}`);
      assert.equal(init?.redirect, "error");
      assert.equal(String(init?.body).includes(canary), false);
      return Response.json(
        String(url).endsWith("/usage")
          ? { key: { usage: 1 } }
          : {
              results: [
                {
                  title: `Cosmetics ${canary}`,
                  url: "https://example.org/offers",
                  content: `Offer ${canary}`,
                },
                { title: "Secret URL", url: `https://example.org/?token=${canary}` },
                { title: "Unsafe", url: "javascript:alert(1)" },
              ],
            },
      );
    },
  });
  const threadId = randomUUID();
  await db.put("owner", "threads", { id: threadId });
  const tool = integrationTools(service, "owner", threadId).find(
    (item) => item.name === "connect_integration",
  );
  assert.ok(tool?.execute);
  const execute = tool.execute as unknown as (args: { id: "tavily" }) => Promise<unknown>;
  const request = (await execute({ id: "tavily" })) as Awaited<ReturnType<typeof service.request>>;
  assert.equal(request.schema.integrationId, "tavily");
  assert.equal(request.schema.fields[0].type, "password");
  assert.equal((await service.request("owner", { id: "tavily", threadId })).id, request.id);
  await assert.rejects(
    service.status("other", request.id),
    (e: unknown) => e instanceof AppError && e.status === 404,
  );
  const alternate = await service.request("owner", { id: "tavily" });
  const saved = await service.submit("owner", request.id, {
    clientResponseId: "save-integration-123",
    values: { apiKey: canary },
  });
  assert.equal(saved.status, "saved");
  assert.equal((await service.status("owner", alternate.id)).status, "superseded");
  assert.equal((await service.catalog("owner"))[0].status, "connected");
  assert.equal(
    (
      await service.submit("owner", request.id, {
        clientResponseId: "save-integration-123",
        values: { apiKey: canary },
      })
    ).status,
    "saved",
  );
  assert.equal(calls.length, 1);
  let fallbackCalls = 0;
  const backend = new ConnectedSearchBackend(service, {
    async search() {
      fallbackCalls++;
      throw new Error("No fallback expected");
    },
  });
  const result = await backend.search({ query: "makeup", limit: 3 }, { owner: "owner" });
  assert.equal(result.provenance.provider, "tavily");
  searchResultSchema.parse(result);
  assert.equal(result.sources.length, 1);
  assert.equal(fallbackCalls, 0);
  const allRecords = await Promise.all(
    [
      "integration-requests",
      "interaction-requests",
      "integrations",
      "mutation-receipts",
      "tasks",
    ].map((kind) => db.list("owner", kind)),
  );
  assert.equal(
    JSON.stringify({ allRecords, result, saved, catalog: await service.catalog("owner") }).includes(
      canary,
    ),
    false,
  );
  assert.equal(values.size, 1);
  await service.disconnect("owner");
  assert.equal(values.size, 0);
  assert.equal((await service.catalog("owner"))[0].status, "disconnected");
  assert.equal(await service.search({ query: "q", limit: 2 }, { owner: "owner" }), null);
});

test("Tavily rejects invalid keys without persisting or echoing provider bodies; retry keeps same secure form", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const { vault, values } = vaultFixture();
  const service = new IntegrationService(db, vault, {
    available: true,
    fetch: async () => new Response(canary, { status: 401 }),
  });
  const request = await service.request("owner", { id: "tavily" });
  await assert.rejects(
    service.submit("owner", request.id, {
      clientResponseId: "invalid-123",
      values: { apiKey: canary },
    }),
    (e: unknown) =>
      e instanceof AppError && e.code === "INTEGRATION_INVALID_KEY" && !e.message.includes(canary),
  );
  assert.equal(values.size, 0);
  assert.equal((await service.status("owner", request.id)).status, "waiting");
  assert.equal((await service.catalog("owner"))[0].status, "disconnected");
});

test("Tavily expiration and revocation retire pending cards; cancelled search does not dispatch", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const { vault } = vaultFixture();
  let clock = Date.now(),
    calls = 0;
  const service = new IntegrationService(db, vault, {
    available: true,
    now: () => clock,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  const request = await service.request("owner", { id: "tavily" });
  clock += 31 * 60_000;
  assert.equal((await service.status("owner", request.id)).status, "expired");
  await assert.rejects(
    service.submit("owner", request.id, {
      clientResponseId: "expired-123",
      values: { apiKey: canary },
    }),
  );
  const current = await service.request("owner", { id: "tavily" });
  await service.disconnect("owner");
  assert.equal((await service.status("owner", current.id)).status, "superseded");
  await assert.rejects(
    service.search({ query: "q", limit: 2 }, { owner: "owner", signal: AbortSignal.abort() }),
  );
  assert.equal(calls, 0);
});

test("integration routes accept secrets only on secure submission, and unavailable vault remains explicit", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const { vault } = vaultFixture();
  const service = new IntegrationService(db, vault, { available: false });
  assert.equal((await service.catalog("owner"))[0].status, "unavailable");
  await assert.rejects(
    service.request("owner", { id: "tavily" }),
    (e: unknown) => e instanceof AppError && e.code === "VAULT_UNAVAILABLE",
  );
  const app = new Hono<{ Variables: { owner: string } }>();
  app.use("*", async (c, next) => {
    c.set("owner", "owner");
    await next();
  });
  app.onError(() => new Response("Invalid request", { status: 422 }));
  app.route("/api", integrationRoutes(service));
  const response = await app.request("/api/integrations/tavily/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: canary }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.text()).includes(canary), false);
});
