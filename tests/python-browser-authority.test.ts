import assert from "node:assert/strict";
import test from "node:test";
import { pythonBrowserDesktop, pythonRuntime } from "./helpers/python-runtime.ts";

const browserCell = {
  capabilityVersion: 3,
  advertisedPythonVersions: [3],
  fresh: true,
  browserSession: "documents",
};

test("browser source receives server-owned desktop and profile fences in its canonical envelope", async (t) => {
  await pythonRuntime(
    t,
    async ({ server, operation }) => {
      assert.ok(operation.browserAuthority, "Python alone must not authorize a browser profile");
      assert.equal(operation.browserAuthority.sessionId, pythonBrowserDesktop.id);
      assert.equal(
        operation.browserAuthority.sessionGeneration,
        pythonBrowserDesktop.sessionGeneration,
      );
      assert.equal(
        operation.browserAuthority.browserSessionId,
        pythonBrowserDesktop.browserSessionId,
      );
      assert.equal(operation.browserAuthority.profileId, pythonBrowserDesktop.profileId);
      assert.equal(operation.browserAuthority.controlRevision, 0);
      assert.equal(
        operation.browserAuthority.resourceKey,
        `desktop:${operation.executorId}:${pythonBrowserDesktop.id}`,
      );
      assert.equal(
        operation.browserAuthority.profileKey,
        `browser-profile:${operation.executorId}:${pythonBrowserDesktop.profileId}`,
      );
      assert.ok(operation.browserAuthority.resourceFence > 0);
      assert.ok(operation.browserAuthority.profileFence > 0);
      const saved = await server.db.get<{ nativeEnvelope?: { browserAuthority?: unknown } }>(
        "owner",
        "task-operations",
        operation.id,
      );
      assert.deepEqual(saved?.nativeEnvelope?.browserAuthority, operation.browserAuthority);
    },
    ["browser_harness_rpc"],
    browserCell,
  );
});

for (const browserResources of ["without-desktop", "without-profile"] as const) {
  test(`browser source cannot dispatch ${browserResources} exclusive lease`, async (t) => {
    let reached = false;
    await assert.rejects(
      pythonRuntime(
        t,
        async () => {
          reached = true;
        },
        ["browser_harness_rpc"],
        { ...browserCell, browserResources },
      ),
      /resource|busy|lease/i,
    );
    assert.equal(reached, false);
  });
}

test("a control takeover revokes a browser program before its next dispatch", async (t) => {
  await pythonRuntime(
    t,
    async ({ server, authority, operation }) => {
      await server.db.put("owner", "desktop-control", {
        id: pythonBrowserDesktop.id,
        control: "human",
        revision: 1,
        generation: pythonBrowserDesktop.sessionGeneration,
      });
      await assert.rejects(
        authority.beforeDispatch("owner", operation),
        /human control|control revision|authority changed/i,
      );
    },
    ["browser_harness_rpc"],
    browserCell,
  );
});

test("a caller cannot replace canonical browser authority with another profile", async (t) => {
  await pythonRuntime(
    t,
    async ({ authority, operation }) => {
      assert.ok(operation.browserAuthority);
      const forged = {
        ...operation,
        browserAuthority: { ...operation.browserAuthority, profileId: "foreign-profile" },
      };
      await assert.rejects(
        authority.beforeDispatch("owner", forged),
        /browser.*authority|binding.*changed/i,
      );
    },
    ["browser_harness_rpc"],
    browserCell,
  );
});
