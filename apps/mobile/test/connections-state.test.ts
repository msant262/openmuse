import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendCatalogPage,
  type ConnectionToolkit,
  catalogPath,
  connectionRequestStatus,
  connectionStatusLabel,
  googleConnectionDestination,
  safeConnectionAuthorizationUrl,
} from "../src/connections-state.ts";

const item = (slug: string, name = slug): ConnectionToolkit => ({
  slug,
  name,
  description: "",
  categories: [],
  authSchemes: [],
  noAuth: false,
  deprecated: false,
});

test("unconfigured Google opens the matching catalog app instead of native OAuth", () => {
  for (const toolkit of ["gmail", "googlecalendar"] as const) {
    assert.equal(
      googleConnectionDestination({ toolkit, configured: false, hasAccount: false }),
      toolkit,
    );
    assert.equal(
      googleConnectionDestination({ toolkit, configured: true, hasAccount: false }),
      "native",
    );
  }
});

test("existing native Google accounts remain manageable when OAuth setup becomes unavailable", () => {
  assert.equal(
    googleConnectionDestination({
      toolkit: "gmail",
      configured: false,
      hasAccount: true,
    }),
    "native",
  );
});

test("catalog search, category and opaque cursors stay independent query parameters", () => {
  const url = new URL(
    catalogPath("  research & reports  ", "business/analytics", "cursor+=/"),
    "https://app.example",
  );
  assert.equal(url.pathname, "/api/composio/catalog");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    limit: "24",
    search: "research & reports",
    category: "business/analytics",
    cursor: "cursor+=/",
  });
});

test("loading a catalog page preserves earlier results without duplicate provider rows", () => {
  const result = appendCatalogPage(
    [item("one"), item("two")],
    [item("two", "Updated"), item("new-provider")],
  );
  assert.deepEqual(
    result.map((value) => [value.slug, value.name]),
    [
      ["one", "one"],
      ["two", "Updated"],
      ["new-provider", "new-provider"],
    ],
  );
});

test("only official server-issued HTTPS Connect Links can be opened", () => {
  for (const host of ["connect.composio.dev", "app.composio.dev"]) {
    const url = `https://${host}/link/lt_example?state=opaque`;
    assert.equal(safeConnectionAuthorizationUrl(url), url);
  }
  for (const url of [
    undefined,
    "javascript:alert(1)",
    "http://connect.composio.dev/link/a",
    "https://connect.composio.dev.evil.test/link/a",
    "https://user:pass@connect.composio.dev/link/a",
    "https://connect.composio.dev:8443/link/a",
    "https://connect.composio.dev/settings",
    "https://backend.composio.dev/link/a",
  ])
    assert.equal(safeConnectionAuthorizationUrl(url), undefined);
});

test("expired and failed authorization retain a recovery screen instead of silently closing", () => {
  assert.equal(connectionRequestStatus("error"), false);
  assert.equal(connectionRequestStatus("expired"), false);
  assert.equal(connectionRequestStatus("waiting"), false);
  assert.equal(connectionRequestStatus("connected"), true);
  assert.equal(connectionRequestStatus("cancelled"), true);
  assert.equal(connectionStatusLabel("ACTIVE"), "Connected");
  assert.equal(connectionStatusLabel("EXPIRED"), "Reconnect to continue");
  assert.equal(connectionStatusLabel("INACTIVE"), "Disconnected");
});
