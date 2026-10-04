import assert from "node:assert/strict";
import test from "node:test";
import { lastValueFrom, toArray } from "rxjs";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { browserImageMessages } from "../apps/server/src/providers/browser-images.ts";
import { modelProviderConfig } from "../apps/server/src/providers/config.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6yS8AAAAASUVORK5CYII=",
  "base64",
);

for (const generated of [true, false])
  test(`view_file sends actual pixels for ${generated ? "durably generated" : "uploaded"} owned images to the provider`, async (t) => {
    let fileId = "";
    const model = await modelFixture(t, (index) =>
      index === 0 ? { name: "view_file", arguments: { fileId } } : undefined,
    );
    const providers = modelProviderConfig("/tmp/file-vision-transport", {
      ...process.env,
      MODEL_CAPABILITIES: JSON.stringify({
        "openai/fixture": {
          tools: true,
          vision: true,
          structuredOutput: true,
          contextTokens: 131072,
        },
      }),
    });
    const server = await taskRuntime(t, {
      agentBackend: "model",
      model: "openai/fixture",
      modelProviders: providers,
    });
    const file = await server.files.importAttachment(
      "owner",
      "document-preview.png",
      png,
      "Preview fixture",
      undefined,
      generated ? "rendered-document-page" : undefined,
    );
    fileId = file.id;
    assert.match(fileId, generated ? /^[a-f0-9]{64}$/ : /^[a-f0-9-]{36}$/);
    const events = await lastValueFrom(
      new ConversationAgent(server.agent.config, server.agent, "owner")
        .run({
          threadId: "file-vision",
          runId: `inspect-${generated}`,
          messages: [{ id: "request", role: "user", content: "Inspect the supplied image." }],
          tools: [],
          context: [],
          state: {},
        })
        .pipe(toArray()),
    );
    assert.equal(model.requests.length, 2);
    assert.ok(
      model.requests[1].body.includes(`data:image/png;base64,${png.toString("base64")}`),
      "the next model request must contain image pixels, not only file metadata",
    );
    assert.ok(!JSON.stringify(events).includes(png.toString("base64")));
    await assert.rejects(
      browserImageMessages(
        [{ role: "tool", content: JSON.stringify(await server.files.reference("owner", fileId)) }],
        undefined,
        (id) => server.files.imageContent("other-owner", id),
      ),
      /not found/,
    );
  });

test("file vision references reject arbitrary paths and malformed identifiers before loading", async () => {
  for (const fileId of ["../private", "a".repeat(63), "g".repeat(64), "/tmp/image.png"])
    assert.equal(
      (
        await browserImageMessages(
          [{ role: "tool", content: JSON.stringify({ fileImage: true, fileId }) }],
          undefined,
          async () => {
            assert.fail("malformed identifiers must not call the file loader");
          },
        )
      ).length,
      1,
    );
});
