import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { createApp } from "../../apps/server/src/app.ts";
import { browserTools } from "../../apps/server/src/browser-tools.ts";
import type { SecretStore } from "../../apps/server/src/credentials/contracts.ts";
import type { TaskContext } from "../../apps/server/src/engine/worker.ts";
import type { ExecutorOperation } from "../../apps/server/src/executors/protocol.ts";
import type { AgentTask } from "../../packages/domain/src/agent.ts";
import { verifyBrowserExecutor } from "../../packages/domain/src/browser-executor.ts";
import { browserFixture } from "./browser.ts";
import { hello, nodeToken, registration } from "./executors.ts";

type BrowserResult = {
  sessionId: string;
  snapshotId: string;
  url: string;
  text: string;
  code?: string;
  error?: string;
};

/** Real app, task authority, resource leases and both transport protocols. Only
 * site observations are supplied by fixtures; no physical machine is claimed. */
export async function browserFallbackFixture(t: TestContext) {
  const cleanup: (() => Promise<void>)[] = [];
  const vpsCalls: { path: string; body: Record<string, unknown> }[] = [];
  const profiles = new Map<string, string>();
  const secrets = new Map<string, Record<string, string>>();
  let credentialResponse:
    | "authenticated"
    | "challenge"
    | "captcha"
    | "disconnect"
    | "invalid"
    | "truncated"
    | "uncertain" = "authenticated";
  let challengeResponse: "authenticated" | "invalid" | "truncated" = "authenticated";
  let beforeSecretRead: (() => Promise<void>) | undefined;
  const canary = "PRIVATE-FALLBACK-CREDENTIAL-CANARY";
  const adapter = {
    id: "fixture-account",
    serviceName: "Fixture account",
    origin: "https://example.com",
    loginUrl: "https://example.com/login",
    fields: [
      { id: "username", label: "Username", type: "text" as const },
      { id: "password", label: "Password", type: "password" as const },
    ],
    selectors: { username: "[name=username]", password: "[name=password]" },
    submitSelector: "[type=submit]",
    authenticatedSelector: "[data-authenticated]",
    challengeSelectors: { otp: "[name=otp]", captcha: "#challenge" },
    challengeSubmitSelector: "[data-verify]",
  };
  const secretStore: SecretStore = {
    async read(_owner, id) {
      await beforeSecretRead?.();
      const data = secrets.get(id);
      return data ? { version: 1, data } : null;
    },
    async write(_owner, id, data) {
      secrets.set(id, data);
      return 1;
    },
    async delete(_owner, id) {
      secrets.delete(id);
    },
  };
  const worker = await browserFixture(
    { after: (close: () => Promise<void>) => cleanup.push(close) } as unknown as TestContext,
    (path, body, request) => {
      if (path === "/health") return { data: { ok: true } };
      if (path === "/executor")
        return {
          data: {
            executorId: "openmuse-server",
            instanceId: "fallback-instance",
            minProtocolVersion: 1,
            maxProtocolVersion: 1,
            capabilities: [
              { name: "browser.dom", version: 1 },
              { name: "browser.screenshot", version: 1 },
            ],
          },
        };
      const authority = verifyBrowserExecutor(
        "test-worker-token-at-least-32-characters",
        String(request.headers["x-openmuse-browser-authority"]),
      );
      assert(authority);
      assert(authority.fence > 0);
      assert.equal(authority.instanceId, "fallback-instance");
      assert.equal(authority.profileId, authority.sessionId);
      vpsCalls.push({
        path,
        body: path.endsWith("/credentials")
          ? { origin: body.origin, adapterId: body.adapterId }
          : body,
      });
      const id = path === "/sessions" ? String(body.id) : path.split("/")[2];
      assert.equal(id, authority.sessionId);
      if (path === "/sessions") profiles.set(id, String(body.url));
      if (path.endsWith("/credentials")) {
        assert.equal(authority.operationClass, "mutable");
        assert.equal(body.origin, adapter.origin);
        assert.equal((body.fields as { value: string }[])[1]?.value, canary);
        if (credentialResponse === "disconnect") request.socket.destroy();
        if (credentialResponse === "invalid") return { data: { status: "authenticated" } };
        if (credentialResponse === "truncated")
          return { data: null, raw: '{"status":"authenticated",' };
        return {
          data: {
            status: ["challenge", "captcha"].includes(credentialResponse)
              ? "challenge"
              : credentialResponse === "uncertain"
                ? "outcome_unknown"
                : "authenticated",
            sessionId: id,
            origin: adapter.origin,
            ...(["challenge", "captcha"].includes(credentialResponse)
              ? {
                  challengeKind: credentialResponse === "captcha" ? "captcha" : "otp",
                  challengeId: randomUUID(),
                }
              : {}),
          },
        };
      }
      if (path.endsWith("/search")) {
        assert.equal(authority.operationClass, "public_read");
        return {
          data: {
            query: body.query,
            status: "ok",
            truncated: false,
            sources: [
              { title: "Source", url: "https://example.com/source", snippet: "Index snippet" },
            ],
            observedAt: new Date().toISOString(),
            provenance: {
              backend: "browser",
              provider: "duckduckgo-html",
              searchUrl: "https://html.duckduckgo.com/html/",
              sessionId: id,
              fullPagesRead: false,
            },
          },
        };
      }
      if (path.endsWith("/challenge")) {
        assert.equal(authority.operationClass, "mutable");
        if (challengeResponse === "invalid") return { data: { status: "authenticated" } };
        if (challengeResponse === "truncated")
          return { data: null, raw: '{"status":"authenticated",' };
        return { data: { status: "authenticated", sessionId: id } };
      }
      const url = profiles.get(id) ?? "https://example.com/";
      return {
        data: path.endsWith("/snapshot")
          ? snapshot(id, url, "VPS evidence")
          : {
              id,
              url,
              title: "Fixture page",
              status: "active",
              control: "agent",
              updatedAt: new Date().toISOString(),
            },
      };
    },
  );
  const server = await createApp(
    worker.db,
    {
      ...worker.config,
      intelligenceApiKey: undefined,
      browserFallbackEnabled: true,
      computerEnabled: true,
      computerBackend: "native",
      computerProfile: "open",
      nativeExecutorId: registration.executorId,
      nativeExecutors: [{ ...registration, owner: "local-user" }],
      taskWorkerEnabled: false,
    },
    { credentialSecretStore: secretStore, credentialAdapters: [adapter] },
  );
  const session = {
    id: randomUUID(),
    sessionGeneration: randomUUID(),
    browserSessionId: randomUUID(),
    profileId: "personal",
    width: 640,
    height: 360,
  };
  const nativeHello = {
    ...hello,
    capabilities: [
      ...hello.capabilities,
      { name: "desktop", version: 1 },
      { name: "browser.dom", version: 1 },
      { name: "browser.screenshot", version: 1 },
    ],
    readiness: {
      ...hello.readiness,
      display: { state: "ready" },
      capture: { state: "ready" },
      input: { state: "ready" },
      browser: { state: "ready" },
      desktopSession: session,
    },
  };
  const node = async (route: string, body: unknown) => {
    const response = await server.app.request(`/executor/${registration.executorId}/${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const epoch = (await node("register", nativeHello)).epoch as number;
  await node("reconcile", { epoch, bootId: hello.bootId, operations: [], contained: true });
  const offline = () =>
    worker.db.compareAndSwap(
      "__executors__",
      "nodes",
      registration.executorId,
      {},
      { lastHeartbeatAt: 0 },
    );
  const nativeCalls: ExecutorOperation[] = [];
  let failOperation: string | undefined,
    stop = false,
    pumpError: unknown,
    nativeUrl = "https://example.com/";
  const pump = (async () => {
    while (!stop) {
      const batch = await server.executors.claimOperations(registration.executorId, epoch, {
        waitMs: 0,
      });
      for (const operation of batch.operations) {
        nativeCalls.push(operation);
        const endpoint = String(operation.args.operation);
        if (endpoint === failOperation) {
          failOperation = undefined;
          await offline();
          await node("receipt", {
            epoch,
            operationId: operation.id,
            sequence: 1,
            receipt: {
              status: "outcome_unknown",
              message: "Fixture lost browser response",
              data: { code: "OUTCOME_UNKNOWN", cleanupConfirmed: endpoint === "snapshot" },
            },
          });
        } else {
          if (endpoint === "open") nativeUrl = String((operation.args.body as { url: string }).url);
          const data =
            endpoint === "snapshot" || endpoint === "act"
              ? snapshot(session.browserSessionId, nativeUrl, "Lenovo evidence")
              : {
                  id: session.browserSessionId,
                  url: nativeUrl,
                  title: "Fixture page",
                  status: "active",
                  control: "agent",
                  updatedAt: new Date().toISOString(),
                };
          await node("receipt", {
            epoch,
            operationId: operation.id,
            sequence: 1,
            receipt: { status: "succeeded", data },
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  void pump.catch((error) => {
    pumpError = error;
  });
  t.after(async () => {
    stop = true;
    await pump.catch(() => {});
    if (server.threads && "close" in server.threads) await server.threads.close();
    await server.agent.stop();
    for (const close of cleanup) await close();
    assert.equal(pumpError, undefined);
  });
  const toolsFor = (owner: string, task: AgentTask, context: TaskContext) =>
    browserTools(server.agent.browser, owner, {
      taskId: task.id,
      before: context.guard,
      signal: context.signal,
      trackResourceLeases: context.trackResourceLeases,
      record: (name, args, execute) =>
        server.agent.journal.run(
          owner,
          task,
          { id: randomUUID(), name, args },
          execute,
          !["browser_research", "browser_snapshot", "browser_screenshot"].includes(name),
        ),
    });
  const invokeFor = (owner: string, task: AgentTask, context: TaskContext) => {
    const tools = toolsFor(owner, task, context);
    return async (name: string, args: unknown) => {
      const tool = tools.find((value) => value.name === name);
      assert(tool);
      return (await (tool.execute as (args: unknown) => Promise<unknown>)(args)) as BrowserResult;
    };
  };
  const runTask = async (
    execute: (
      invoke: (name: string, args: unknown) => Promise<BrowserResult>,
      task: AgentTask,
      context: TaskContext,
    ) => Promise<void>,
  ) => {
    let failure: unknown;
    server.agent.configureNativeExecution(async (owner, task, context) => {
      try {
        await execute(invokeFor(owner, task, context), task, context);
      } catch (error) {
        failure = error;
      }
      return { status: "waiting_input", question: "Fixture task stopped for inspection" };
    });
    const task = await server.agent.createTask("local-user", {
      kind: "agent",
      prompt: "Browser fallback fixture",
    });
    await server.agent.worker.tick();
    if (failure) throw failure;
    return task;
  };
  return {
    ...server,
    db: worker.db,
    session,
    epoch,
    node,
    nativeHello,
    offline,
    nativeCalls,
    vpsCalls,
    runTask,
    invokeFor,
    canary,
    saveCredential: async () => {
      const id = randomUUID();
      secrets.set(id, { username: "fixture-owner", password: canary });
      await worker.db.put("local-user", "credentials", {
        id,
        adapterId: adapter.id,
        serviceName: adapter.serviceName,
        origin: adapter.origin,
        credentialRef: { id, version: 1 },
        status: "saved",
        updatedAt: new Date().toISOString(),
      });
      return { id, version: 1 };
    },
    challengeResponse: (value: typeof challengeResponse) => {
      challengeResponse = value;
    },
    credentialResponse: (value: typeof credentialResponse) => {
      credentialResponse = value;
    },
    beforeSecretRead: (operation: () => Promise<void>) => {
      beforeSecretRead = operation;
    },
    stopNative: async () => {
      stop = true;
      await pump;
    },
    failNext: (endpoint: string) => {
      failOperation = endpoint;
    },
  };
}

function snapshot(sessionId: string, url: string, text: string) {
  return {
    sessionId,
    snapshotId: randomUUID(),
    url,
    title: "Fixture page",
    text,
    truncated: false,
    truncatedElements: false,
    control: "agent",
    elements: [
      {
        number: 1,
        tag: "button",
        role: "button",
        label: "Fixture control",
        disabled: false,
        frameUrl: url,
      },
    ],
  };
}
