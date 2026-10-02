import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { providerContinuationCheckpointSchema } from "../apps/server/src/providers/models.ts";
import { modelFixture } from "./helpers/model.ts";

test("a completed HTTP file effect resumes after provider interruption and disk restart without repeating the write", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "okami-provider-restart-"));
  let writes = 0;
  const physicalPath = join(directory, "remote-report.txt");
  const remote = createServer(async (request, response) => {
    let input = "";
    for await (const chunk of request) input += chunk;
    const args = JSON.parse(input || "{}");
    response.writeHead(200, { "Content-Type": "application/json" });
    if (args.operation === "write") {
      writes++;
      await writeFile(physicalPath, args.text);
      response.end(JSON.stringify({ path: args.path }));
    } else if (args.operation === "read")
      response.end(JSON.stringify({ path: args.path, text: await readFile(physicalPath, "utf8") }));
    else response.end(JSON.stringify({ status: "running", commands: [] }));
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  const address = remote.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    remote.closeAllConnections();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  });
  const fixture = await modelFixture(
    t,
    (index) =>
      index === 0
        ? {
            name: "write_computer_file",
            arguments: { path: "/workspace/report.txt", text: "Concrete saved note" },
          }
        : index === 2
          ? { name: "read_computer_file", arguments: { path: "/workspace/report.txt" } }
          : { name: "finish_task", arguments: { summary: "Verified the saved note" } },
    { cleanEof: (index) => index === 1 },
  );
  const providers = modelProviderConfig(directory, {
    LOCAL_BASE_URL: process.env.OPENAI_BASE_URL,
    LOCAL_API: "responses",
    MODEL_CAPABILITIES: JSON.stringify({
      "local/worker": { tools: true, vision: false, structuredOutput: true, contextTokens: 131072 },
    }),
  });
  const config = {
    mode: "sample" as const,
    agentBackend: "model" as const,
    model: "local/worker",
    modelProviders: providers,
    dataDir: directory,
    host: "127.0.0.1",
    port: 8787,
    publicUrl: "http://localhost:8787",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    computerEnabled: true,
    computerBackend: "rpc" as const,
    computerProfile: "open" as const,
    computerUrl: `http://127.0.0.1:${address.port}`,
    computerToken: "fixture-computer-token-32-characters",
  };
  let db = await createStore({ dataDir: join(directory, "db") });
  let app = await createApp(db, config);
  let open = true;
  t.after(async () => {
    if (open) {
      await app.agent.stop();
      await db.close();
    }
    await rm(directory, { recursive: true, force: true });
  });
  const task = await app.agent.createTask("owner", {
    prompt: "Write the supplied note and verify its saved content",
    criteria: [
      {
        id: "saved-content",
        kind: "observation",
        description: "The saved content is observed",
        requiredItems: ["Concrete saved note"],
      },
    ],
  });
  await app.agent.worker.tick();
  const interrupted = await app.agent.getTask("owner", task.id);
  assert.equal(interrupted.status, "waiting_provider", interrupted.error ?? interrupted.question);
  const checkpoint = providerContinuationCheckpointSchema.parse(
    interrupted.state.providerCheckpoint,
  );
  assert.ok(
    checkpoint.messages.some(
      (message) => message.role === "tool" && message.toolCallId === "call-0",
    ),
  );
  assert.equal(writes, 1);
  assert.equal(await readFile(physicalPath, "utf8"), "Concrete saved note");
  await app.agent.stop();
  await db.close();
  open = false;
  db = await createStore({ dataDir: join(directory, "db") });
  app = await createApp(db, config);
  open = true;
  assert.equal((await app.agent.getTask("owner", task.id)).status, "waiting_provider");
  await app.agent.actor.wake("owner", task.id, "provider");
  await app.agent.worker.tick();
  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(saved.state.providerCheckpoint, null);
  assert.equal(writes, 1, "the completed external effect is not repeated after restart");
  assert.match(fixture.requests[2].body, /write_computer_file/);
  assert.match(fixture.requests[2].body, /call-0/);
  assert.equal(
    (await app.agent.journal.operations("owner", task.id)).filter(
      (operation) => operation.toolName === "write_computer_file",
    ).length,
    1,
  );
});
