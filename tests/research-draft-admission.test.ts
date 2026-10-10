import assert from "node:assert/strict";
import test from "node:test";
import { reviewResearchDelivery } from "../apps/server/src/engine/research-delivery-review.ts";
import { reviewedDocumentTextPresent } from "../apps/server/src/engine/research-document-proof.ts";
import { FileLibrary } from "../apps/server/src/file-library.ts";
import { documentArgs } from "../apps/server/src/media-tools.ts";
import { modelFixture } from "./helpers/model.ts";
import { taskRuntime } from "./helpers/task-runtime.ts";

test("an unqualified comparison is repaired before rendering, and its qualified PDF needs only one successful factual check", async (t) => {
  const badUrl = "https://academy.example/trial";
  const goodUrl = "https://academy.example/open";
  let fileId = "",
    receiptId = "";
  const fixture = await modelFixture(
    t,
    (i) => {
      if (i === 2) {
        const input = JSON.parse(fixture.requests[i].body).input;
        const result = JSON.parse(
          input.findLast((item: { type: string }) => item.type === "function_call_output").output,
        );
        assert.equal(result.complete, false);
        assert.equal(result.repairable, true);
        assert.equal(result.fileId, undefined, "the unqualified proposal must not become a PDF");
      }
      return [
        { name: "web_fetch", arguments: { url: badUrl } },
        {
          name: "create_document",
          arguments: {
            name: "AI course",
            format: "pdf",
            operationId: "unqualified",
            content: `# Preview AI\n\nAccess is not confirmed free. English, two hours. Certificate not stated.\n\nSource: ${badUrl}`,
          },
        },
        { name: "web_fetch", arguments: { url: goodUrl } },
        {
          name: "create_document",
          arguments: {
            name: "AI course",
            format: "pdf",
            operationId: "qualified",
            content: `# Open AI\n\nAll lessons are free. English, two hours. Optional certificate: paid.\n\nSource: ${goodUrl}`,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: { summary: "The PDF comparison is attached.", artifactIds: [fileId] },
        },
      ][i];
    },
    {
      researchReview: (body) => {
        const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
        const bad = input.proposedAnswer.includes("Preview AI");
        return {
          complete: !bad,
          needsMoreResearch: bad,
          missing: bad ? ["Full course access is unconfirmed"] : [],
          nextSteps: bad ? ["Read a qualified alternative"] : [],
          accessAudit: [
            {
              option: bad ? "Preview AI" : "Open AI",
              access: bad ? "unknown" : "free",
              sourceUrl: bad ? badUrl : goodUrl,
              ...(bad ? {} : { quote: "All lessons are free." }),
            },
          ],
        };
      },
    },
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body:
      url === badUrl
        ? "<main>Sign in for a trial.</main>"
        : "<main>Open AI. All lessons are free. English, two hours. Optional certificate: paid.</main>",
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
      "Research one free introductory AI course and deliver a PDF comparing content, language, duration and certificate cost.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(
    (await f.db.list("owner", "document-generations")).length,
    1,
    "no rejected draft was rendered or persisted",
  );
  assert.equal(
    fixture.reviewRequests.length,
    2,
    "one rejected proposal and one qualified factual check; no duplicate final check",
  );
  const actual = await new FileLibrary(f.files, f.db).read("owner", {
    fileId,
    offset: 0,
    limit: 100_000,
  });
  assert.match(actual.text, /Optional certificate: paid/);
  assert.doesNotMatch(actual.text, /Preview AI/);
  assert.deepEqual(saved.artifactIds, [fileId]);
});

test("rendered coverage preserves negations, values and every requested field across page headers", () => {
  const args = documentArgs.parse({
    name: "Comparison",
    format: "pdf",
    operationId: "coverage",
    content:
      "# Open AI\n\nEnglish. Two hours. Certificate is not free.\n\n| Course | Fee |\n|---|---|\n| Open AI | €20 |\n| Intro AI | €30 |",
  });
  assert.equal(
    reviewedDocumentTextPresent(args, {
      text: "Open AI English. Two hours. Certificate is Comparison page 2 not free. Course Fee Open AI €20 Intro AI €30",
      nextOffset: null,
    }),
    true,
  );
  for (const text of [
    "Open AI English. Two hours. Certificate is free. Course Fee Open AI €20 Intro AI €30",
    "Open AI English. Two hours. Certificate is not free. Course Fee Open AI €200 Intro AI €30",
    "Open AI English. Two hours. Certificate is not free. Course Fee Open AI €20",
  ])
    assert.equal(reviewedDocumentTextPresent(args, { text, nextOffset: null }), false);
  assert.equal(
    reviewedDocumentTextPresent(args, {
      text: "Open AI English. Two hours. Certificate is not free. Course Fee Open AI €20 Intro AI €30",
      nextOffset: 100,
    }),
    false,
  );
});

test("an unavailable draft review resumes the preserved proposal before another executor turn", async (t) => {
  const url = "https://academy.example/open";
  let unavailable = true;
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
            name: "Open AI",
            format: "pdf",
            operationId: "once",
            content: `# Open AI\n\nAll lessons are free. English. Two hours. Optional certificate: paid.\n\nSource: ${url}`,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: { summary: "The comparison PDF is attached.", artifactIds: [fileId] },
        },
      ][i],
    {
      reviewErrorStatus: () => (unavailable ? 503 : undefined),
      researchReview: () => ({
        complete: true,
        missing: [],
        nextSteps: [],
        accessAudit: [
          { option: "Open AI", access: "free", sourceUrl: url, quote: "All lessons are free." },
        ],
      }),
    },
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  f.agent.config.modelProviders!.routing!.maxAttempts = 1;
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>Open AI. All lessons are free. English. Two hours. Optional certificate: paid.</main>",
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
      "Research a free AI course and deliver a PDF with duration, language and optional certificate cost.",
  });
  await f.agent.worker.tick();
  const waiting = await f.agent.getTask("owner", task.id);
  assert.equal(waiting.status, "waiting_provider");
  assert.equal((await f.db.list("owner", "document-generations")).length, 0);
  assert.ok(waiting.state.pendingDocumentGeneration);
  unavailable = false;
  const { sharedModelRouter } = await import("../apps/server/src/providers/model-router.ts");
  const cooldown = sharedModelRouter(f.agent.config.modelProviders!).health.get(
    "openai/fixture",
  ).cooldownUntil;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, cooldown - Date.now() + 5)));
  await f.db.put("owner", "tasks", { ...waiting, nextRunAt: new Date(0).toISOString() });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal((await f.db.list("owner", "document-generations")).length, 1);
  assert.equal(
    fixture.requests.length,
    5,
    "resume neither asks the executor to regenerate nor refetches the source",
  );
  assert.equal(
    fixture.reviewRequests.length,
    2,
    "one unavailable request then one successful review, with no final duplicate",
  );
});

test("changed source evidence invalidates a draft approval and requires correction of the actual delivered PDF", async (t) => {
  const url = "https://academy.example/open";
  let fileId = "",
    receiptId = "",
    reads = 0;
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url } },
        {
          name: "create_document",
          arguments: {
            name: "Open AI",
            format: "pdf",
            operationId: "initial",
            content: `# Open AI\n\nAll lessons are free. English. Two hours. Optional certificate: paid; price not published.\n\nSource: ${url}`,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        { name: "web_fetch", arguments: { url } },
        {
          name: "finish_task",
          arguments: { summary: "The PDF comparison is attached.", artifactIds: [fileId] },
        },
        {
          name: "create_document",
          arguments: {
            name: "Open AI",
            format: "pdf",
            operationId: "updated",
            replaceFileId: fileId,
            content: `# Open AI\n\nAll lessons are free. English. Two hours. Optional certificate: paid, €20.\n\nSource: ${url}`,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: {
            summary: "The corrected PDF comparison is attached.",
            artifactIds: [fileId],
          },
        },
      ][i],
    {
      researchReview: (body, i) => {
        const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
        if (i === 1) {
          assert.equal(input.proposedDocument, false);
          assert.match(input.documents[0].text, /price not published/);
          assert.ok(input.observations.some((read: { text: string }) => read.text.includes("€20")));
        }
        return {
          complete: i !== 1,
          needsMoreResearch: false,
          missing: i === 1 ? ["The certificate fee is now published"] : [],
          nextSteps: i === 1 ? ["Correct the actual document to state €20"] : [],
          accessAudit: [
            { option: "Open AI", access: "free", sourceUrl: url, quote: "All lessons are free." },
          ],
        };
      },
    },
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: `<main>Open AI. All lessons are free. English. Two hours. Optional certificate: paid${++reads === 1 ? "; price not published" : ", €20"}.</main>`,
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
      "Research a free AI course and deliver a PDF with content, language, duration and certificate cost.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal((await f.db.list("owner", "document-generations")).length, 2);
  assert.equal(
    fixture.reviewRequests.length,
    3,
    "the changed evidence is reviewed; the unchanged final render is not reviewed twice",
  );
  const actual = await new FileLibrary(f.files, f.db).read("owner", {
    fileId,
    offset: 0,
    limit: 100_000,
  });
  assert.match(actual.text, /€20/);
  assert.doesNotMatch(actual.text, /price not published/);
  assert.deepEqual(saved.artifactIds, [fileId]);
});

test("an observed exhausted access blocker still permits an honest partial PDF without certifying completion", async (t) => {
  const url = "https://academy.example/invitation-only";
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
            name: "Access limitation",
            format: "pdf",
            operationId: "limitation",
            content: `# Course access limitation\n\nThe named course requires an account invitation. Free access could not be confirmed. No course or certificate prices are asserted.\n\nSource: ${url}`,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: {
            summary:
              "The named course requires an account invitation; its access conditions could not be verified. The PDF records this limitation.",
            outcome: "partial",
            artifactIds: [fileId],
          },
        },
      ][i],
    {
      researchReview: () => ({
        complete: false,
        blocked: true,
        needsMoreResearch: true,
        missing: ["The specifically named course requires an account invitation"],
        nextSteps: [],
        accessAudit: [{ option: "Invitation-only AI", access: "unknown", sourceUrl: url }],
      }),
    },
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>The named course requires an account invitation.</main>",
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
      "Research the free Invitation-only AI course and deliver a PDF stating its access conditions.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal((await f.db.list("owner", "document-generations")).length, 1);
  assert.equal(
    saved.status,
    "failed",
    "a partial limitation report must not certify the requested research as complete",
  );
  assert.notEqual(saved.completion?.status, "verified");
  assert.equal(
    (saved.state.researchDeliveryReview as { reusedContentApproval?: boolean })
      .reusedContentApproval,
    undefined,
  );
  const actual = await new FileLibrary(f.files, f.db).read("owner", {
    fileId,
    offset: 0,
    limit: 100_000,
  });
  assert.match(actual.text, /requires an account invitation/);
});

test("eligible partial drafts can be composed into a multi-file request without pretending that either draft completes it", async (t) => {
  const url = "https://academy.example/open";
  let fileId = "",
    receiptId = "";
  const fileIds: string[] = [];
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url } },
        {
          name: "create_document",
          arguments: {
            name: "Open AI",
            format: "pdf",
            operationId: "open",
            content: `# Open AI\n\nAll lessons are free. English, two hours. Optional certificate: paid.\n\nSource: ${url}`,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "create_document",
          arguments: {
            name: "Intro AI",
            format: "pdf",
            operationId: "intro",
            content: `# Intro AI\n\nAll lessons are free. Portuguese, three hours. Optional certificate: paid.\n\nSource: ${url}`,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: { summary: "Both course reports are attached.", artifactIds: fileIds },
        },
      ][i],
    {
      researchReview: (_body, i) => ({
        complete: i === 2,
        draftEligible: true,
        needsMoreResearch: false,
        missing: i < 2 ? ["The other separately requested report is still to be written"] : [],
        nextSteps: i < 2 ? ["Create the other report"] : [],
        accessAudit: [
          {
            option: i === 1 ? "Intro AI" : "Open AI",
            access: "free",
            sourceUrl: url,
            quote: "All lessons are free.",
          },
        ],
      }),
    },
  );
  const f = await taskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>Open AI and Intro AI. All lessons are free. Open AI: English, two hours. Intro AI: Portuguese, three hours. Optional certificates: paid.</main>",
  }));
  const create = f.agent.media.createDocument.bind(f.agent.media);
  t.mock.method(f.agent.media, "createDocument", async (...args: Parameters<typeof create>) => {
    const result = await create(...args);
    fileId = result.fileId;
    fileIds.push(fileId);
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
      "Research the free Open AI and Intro AI courses and deliver a separate PDF for each with language, duration and certificate cost.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(fileIds.length, 2);
  assert.deepEqual(saved.artifactIds, fileIds);
  assert.equal(fixture.reviewRequests.length, 3);
  const actual = await new FileLibrary(f.files, f.db).read("owner", {
    fileId: fileIds[1],
    offset: 0,
    limit: 100_000,
  });
  assert.match(actual.text, /Intro AI/);
  assert.match(actual.text, /Portuguese, three hours/);
});

test("partial-draft eligibility cannot bypass unknown access or absent source proof", async (t) => {
  const url = "https://academy.example/course";
  const fixture = await modelFixture(t, () => undefined, {
    researchReview: (_body, i) => ({
      complete: false,
      draftEligible: true,
      missing: ["Another document is still required"],
      nextSteps: ["Write the next document"],
      ...(i === 0
        ? { accessAudit: [{ option: "Unknown AI", access: "unknown", sourceUrl: url }] }
        : {}),
    }),
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Research two free AI courses and deliver separate PDF reports.",
  });
  for (let i = 0; i < 2; i++) {
    const decision = await reviewResearchDelivery({
      task,
      summary: "Unknown AI: free access unconfirmed.",
      proposedDocument: true,
      stage: "access_selection",
      model: "openai/fixture",
      providers: f.agent.config.modelProviders!,
      structured: false,
      signal: new AbortController().signal,
      operations: [
        {
          toolName: "web_fetch",
          status: "succeeded",
          args: { url },
          receipt: { url, text: "Sign in to see pricing." },
        },
      ] as never,
    });
    assert.equal(decision.complete, false);
    assert.equal(decision.draftEligible, false);
    assert.match(decision.missing.join(" "), /free access/i);
  }
  assert.equal(fixture.reviewRequests.length, 2);
});
