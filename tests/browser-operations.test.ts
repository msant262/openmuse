import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import { BrowserError, browserActionSchema } from "../apps/server/src/browser-contract.ts";
import { browserTools } from "../apps/server/src/browser-tools.ts";
import { Files } from "../apps/server/src/files.ts";
import { browserFixture } from "./helpers/browser.ts";

const makeSnapshot = (id: string) => ({
  sessionId: id,
  snapshotId: randomUUID(),
  url: "https://example.com/",
  title: "Personal browser",
  text: "Name",
  truncated: false,
  truncatedElements: false,
  control: "agent",
  elements: [
    {
      number: 1,
      tag: "input",
      role: "input",
      type: "text",
      label: "Name",
      disabled: false,
      frameUrl: "https://example.com/",
    },
  ],
});

test("browser image tool binds the owner and validates actual paginated worker observations", async (t) => {
  let id = "",
    foreign = false;
  const imageCalls: Record<string, unknown>[] = [];
  const fixture = await browserFixture(t, (path, body) => {
    if (path === "/sessions") id = String(body.id);
    if (path.endsWith("/images")) {
      imageCalls.push(body);
      return {
        data: {
          sessionId: foreign ? randomUUID() : id,
          url: "https://example.com/",
          observedAt: new Date().toISOString(),
          images: [
            {
              src: "https://example.com/course.png",
              alt: "Course cover",
              width: 320,
              height: 180,
              frameUrl: "https://example.com/",
            },
          ],
          total: 3,
          nextOffset: 1,
          partial: false,
        },
      };
    }
    return {
      data: {
        id,
        url: "https://example.com/",
        title: "Images",
        status: "active",
        control: "agent",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  await fixture.service.agentSession("owner", undefined, "https://example.com/");
  const tool = browserTools(fixture.service, "owner").find(
    (tool) => tool.name === "browser_get_images",
  );
  assert.ok(tool?.execute);
  const input = { sessionId: id, offset: 0, limit: 1 };
  const result = (await tool.execute(input)) as {
    images: { alt: string }[];
    nextOffset: number;
  };
  assert.equal(result.images[0].alt, "Course cover");
  assert.equal(result.nextOffset, 1);
  assert.deepEqual(imageCalls, [{ offset: 0, limit: 1 }]);
  await assert.rejects(fixture.service.images("another-owner", id), { status: 404 });
  await assert.rejects(fixture.service.images("owner", id, { offset: -1 }));
  assert.equal(imageCalls.length, 1, "invalid owner or paging cannot dispatch");
  foreign = true;
  await assert.rejects(fixture.service.images("owner", id), { code: "INVALID_SESSION" });
});

test("browser back retains uncertainty when the worker omits the history receipt", async (t) => {
  let id = "";
  const fixture = await browserFixture(t, (path, body) => {
    if (path === "/sessions") id = String(body.id);
    if (path.endsWith("/back")) return { data: makeSnapshot(id) };
    return {
      data: {
        id,
        url: "https://example.com/",
        title: "History",
        status: "active",
        control: "agent",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  await fixture.service.agentSession("owner", undefined, "https://example.com/");
  await assert.rejects(fixture.service.back("owner", id), { code: "OUTCOME_UNKNOWN" });
});

test("new chat/tasks share the owner profile, explicit foreign profiles are rejected, closed worker profile reopens", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let current: {
    id: string;
    url: string;
    title: string;
    status: string;
    control: string;
    updatedAt: string;
  } = {
    id: "",
    url: "https://example.com/",
    title: "Personal browser",
    status: "closed",
    control: "agent",
    updatedAt: new Date().toISOString(),
  };
  const fixture = await browserFixture(t, (path, body) => {
    calls.push({ path, body });
    if (path === "/sessions")
      current = {
        id: String(body.id),
        url: String(body.url),
        title: "Personal browser",
        status: "active",
        control: "agent",
        updatedAt: new Date().toISOString(),
      };
    if (path.endsWith("/read"))
      return {
        data: { url: current.url, title: current.title, text: "Actual content", truncated: false },
      };
    if (path.endsWith("/snapshot")) return { data: makeSnapshot(current.id) };
    return { data: current };
  });
  const first = await fixture.service.observeForThread(
    "owner",
    "first-thread",
    "https://example.com/",
  );
  const second = await fixture.service.observeForThread(
    "owner",
    "new-thread",
    "https://example.com/",
  );
  assert.equal(first.sessionId, second.sessionId);
  const id = await fixture.service.agentSession("owner");
  assert.equal(id, first.sessionId);
  assert.equal((await fixture.db.list("owner", "browsers")).length, 1);
  await assert.rejects(fixture.service.agentSession("another-owner", id), { status: 404 });
  assert.ok(current);
  current.status = "closed"; // Authoritative worker restart, while DB still says active.
  const restarted = new BrowserService(
    fixture.db,
    fixture.config,
    new Auth(fixture.db, fixture.config, "test-key"),
    new Files(fixture.db, fixture.config, new Auth(fixture.db, fixture.config, "test-key")),
  );
  assert.equal(await restarted.agentSession("owner"), id);
  assert.equal(calls.at(-1)?.path, "/sessions");
  assert.equal(calls.at(-1)?.body.id, id);
});

test("owned browser tools return numbered snapshots and typed takeover errors without control grants", async (t) => {
  let id = "";
  let human = false;
  const fixture = await browserFixture(t, (path, body) => {
    if (path === "/sessions") id = String(body.id);
    if (path.endsWith("/snapshot") || path.endsWith("/act") || path.endsWith("/back")) {
      if (human && (path.endsWith("/act") || path.endsWith("/back")))
        return {
          status: 409,
          data: {
            error: {
              code: "BROWSER_CONTROLLED",
              message: "Hand back to resume",
              details: { sessionId: id },
            },
          },
        };
      return {
        data: { ...makeSnapshot(id), ...(path.endsWith("/back") ? { historyMoved: true } : {}) },
      };
    }
    if (path.endsWith("/agent-screenshot"))
      return {
        data: {
          sessionId: id,
          title: "Personal browser",
          url: "https://example.com/",
          image: Buffer.from("fixture-jpeg").toString("base64"),
          mimeType: "image/jpeg",
          width: 1280,
          height: 800,
          consoleUrl: "must-never-leak-control-grant",
        },
      };
    if (path.endsWith("/control") && body.control) human = body.control === "human";
    return {
      data: {
        id,
        url: "https://example.com/",
        title: "Personal browser",
        status: "active",
        control: human ? "human" : "agent",
        updatedAt: new Date().toISOString(),
      },
    };
  });
  let paused = "";
  const tools = browserTools(fixture.service, "owner", {
    paused: async (id) => {
      paused = id;
    },
  });
  const execute = async (name: string, args: unknown) => {
    const tool = tools.find((tool) => tool.name === name);
    assert.ok(tool);
    return (tool.execute as (args: unknown) => Promise<unknown>)(args);
  };
  const snapshot = (await execute("browser_navigate", {
    url: "https://example.com/",
  })) as ReturnType<typeof makeSnapshot>;
  assert.equal(snapshot.elements[0].number, 1);
  assert.ok(!JSON.stringify(snapshot).includes("signature="));
  const previous = (await execute("browser_back", {})) as ReturnType<typeof makeSnapshot> & {
    historyMoved: boolean;
  };
  assert.equal(previous.sessionId, id);
  assert.equal(previous.historyMoved, true);
  assert.notEqual(previous.snapshotId, snapshot.snapshotId);
  await assert.rejects(fixture.service.back("another-owner", id), { status: 404 });
  await fixture.service.control("owner", id, "human");
  const blockedBack = (await execute("browser_back", {})) as { code: string; paused: boolean };
  assert.equal(blockedBack.code, "BROWSER_CONTROLLED");
  assert.equal(blockedBack.paused, true);
  const result = (await execute("browser_act", {
    act: { snapshotId: snapshot.snapshotId, element: 1, action: "fill", value: "Ana" },
  })) as { code: string; paused: boolean };
  assert.equal(result.code, "BROWSER_CONTROLLED");
  assert.equal(result.paused, true);
  assert.equal(paused, id);
  assert.ok(!JSON.stringify(result).includes("signature="));
  await fixture.service.control("owner", id, "agent");
  const screenshot = (await execute("browser_screenshot", {})) as {
    screenshotId: string;
    browserScreenshot: boolean;
  };
  assert.equal(screenshot.browserScreenshot, true);
  assert.ok(/^[a-f0-9]{64}$/.test(screenshot.screenshotId));
  const hydrated = await fixture.service.screenshotImage("owner", screenshot.screenshotId);
  assert.equal(hydrated.type, "image");
  await assert.rejects(fixture.service.screenshotImage("someone-else", screenshot.screenshotId), {
    status: 404,
  });
  assert.ok(!JSON.stringify(screenshot).includes("must-never-leak"));
  assert.ok(!JSON.stringify(screenshot).includes(Buffer.from("fixture-jpeg").toString("base64")));
  assert.throws(() =>
    browserActionSchema.parse({
      snapshotId: snapshot.snapshotId,
      element: 1,
      action: "click",
      approved: true,
    }),
  );
});

test("worker stale/payment intent errors preserve canonical binding only in trusted service", async (t) => {
  const id = randomUUID();
  const intent = {
    snapshotId: randomUUID(),
    element: 1,
    url: "https://example.com/",
    fingerprint: "Pay",
    formDigest: "digest",
  };
  const fixture = await browserFixture(t, () => ({
    status: 409,
    data: {
      error: { code: "PAYMENT_APPROVAL_REQUIRED", message: "Approval required", details: intent },
    },
  }));
  await fixture.db.put("owner", "browsers", {
    id,
    url: "https://example.com/",
    title: "Pay",
    status: "active",
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(
    fixture.service.act("owner", id, {
      snapshotId: intent.snapshotId,
      element: 1,
      action: "click",
    }),
    (error) =>
      error instanceof BrowserError &&
      error.code === "PAYMENT_APPROVAL_REQUIRED" &&
      error.details !== undefined,
  );
});
