import assert from "node:assert/strict";
import test from "node:test";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

for (const enabled of [false, true])
  test(`ordinary free-course PDF honors the ${enabled ? "enabled" : "disabled"} independent review setting`, async (t) => {
    const url = "https://courses.example/open";
    let fileId = "",
      receiptId = "";
    const fixture = await modelFixture(
      t,
      (i) =>
        [
          { name: "web_fetch", arguments: { url } },
          {
            name: "create_document",
            arguments: {
              name: "Course comparison",
              format: "pdf",
              operationId: "course-report",
              content: `# Open course\n\nThe introductory generative AI lessons are free. English; two hours. Optional certificate: paid.\n\nSource: ${url}`,
            },
          },
          { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
          { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
          {
            name: "finish_task",
            arguments: { summary: "The course comparison is attached.", artifactIds: [fileId] },
          },
        ][i],
      {
        researchReview: (body) => {
          const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
          assert.match(input.documents[0].text, /Optional certificate:\s+paid/);
          return {
            complete: true,
            needsMoreResearch: false,
            missing: [],
            nextSteps: [],
            accessAudit: [
              {
                option: "Open course",
                access: "free",
                sourceUrl: url,
                quote: "The introductory generative AI lessons are free.",
              },
            ],
          };
        },
      },
    );
    const f = await taskRuntime(t, {
      agentBackend: "model",
      model: "openai/fixture",
      researchReviewEnabled: enabled,
    });
    const capability = f.agent.config.modelProviders?.routing?.capabilities["openai/fixture"];
    assert.ok(capability);
    capability.vision = true;
    t.mock.method(f.agent.web, "document", async () => ({
      url,
      contentType: "text/html",
      body: "<main>Open course. The introductory generative AI lessons are free. English; two hours. Optional certificate: paid.</main>",
    }));
    const create = f.agent.media.createDocument.bind(f.agent.media);
    t.mock.method(f.agent.media, "createDocument", async (...args: Parameters<typeof create>) => {
      const result = await create(...args);
      fileId = result.fileId;
      return result;
    });
    const inspect = f.agent.media.inspectDocument.bind(f.agent.media);
    t.mock.method(f.agent.media, "inspectDocument", async (...args: Parameters<typeof inspect>) => {
      const result = await inspect(...args);
      receiptId = result.receiptId;
      return result;
    });
    const task = await f.agent.createTask("owner", {
      prompt:
        "Research a free beginner generative AI course and deliver a PDF comparing content, language, duration and certificate cost.",
    });
    await f.agent.worker.tick();
    const result = await f.agent.getTask("owner", task.id);
    assert.equal(result.status, "succeeded");
    assert.equal(
      result.completion?.status,
      "verified",
      "actual file and visual/effect receipts remain mandatory",
    );
    assert.ok(
      Buffer.from(await f.files.bytes("owner", result.artifactIds[0]))
        .subarray(0, 4)
        .equals(Buffer.from("%PDF")),
    );
    assert.equal(
      fixture.reviewRequests.length,
      enabled ? 1 : 0,
      "task wording must not silently enable a separately configured model pass",
    );
    assert.equal(
      fixture.requests.length,
      5,
      "no repeated executor loop for unchanged selected content",
    );
  });
