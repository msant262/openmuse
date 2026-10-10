import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { reviewResearchDelivery } from "../apps/server/src/engine/research-delivery-review.ts";
import { FileLibrary } from "../apps/server/src/file-library.ts";
import { modelFixture, offeredHostTools } from "./helpers/model.ts";
import { taskRuntime as baseTaskRuntime } from "./helpers/task-runtime.ts";

// These tests exercise the explicitly enabled optional review mode.
function taskRuntime(
  t: Parameters<typeof baseTaskRuntime>[0],
  config: Parameters<typeof baseTaskRuntime>[1] = {},
  options: Parameters<typeof baseTaskRuntime>[2] = {},
) {
  return baseTaskRuntime(t, { ...config, researchReviewEnabled: true }, options);
}

test("an incomplete access audit exposes every unknown selection even when its repair flag claims sources suffice", async (t) => {
  const fixture = await modelFixture(t, () => undefined, {
    researchReview: () => ({
      complete: false,
      needsMoreResearch: false,
      missing: ["Replace the general AI course with a generative AI course"],
      nextSteps: ["Edit the PDF's third row"],
      accessAudit: [
        {
          option: "Preview course",
          access: "unknown",
          sourceUrl: "https://academy.example/preview",
          quote: "Preview",
        },
        {
          option: "Unconfirmed course",
          access: "unknown",
          sourceUrl: "https://academy.example/unconfirmed",
          quote: "Sign in",
        },
        {
          option: "Open foundations",
          access: "free",
          sourceUrl: "https://academy.example/foundations",
          quote: "All course content is free.",
        },
      ],
    }),
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Compare three free beginner generative AI courses.",
  });
  const decision = await reviewResearchDelivery({
    task,
    summary: "Three free courses.",
    model: "openai/fixture",
    stage: "access_selection",
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: {},
        receipt: { url: "https://academy.example/preview", text: "Preview" },
      },
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: {},
        receipt: { url: "https://academy.example/unconfirmed", text: "Sign in" },
      },
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: {},
        receipt: {
          url: "https://academy.example/foundations",
          text: "All course content is free.",
        },
      },
    ] as never,
  });
  assert.equal(decision.complete, false);
  assert.equal(decision.needsMoreResearch, true);
  assert.match(decision.missing.join(" "), /Preview course/);
  assert.match(decision.missing.join(" "), /Unconfirmed course/);
  assert.match(decision.nextSteps.join(" "), /Preview course/);
  assert.match(decision.nextSteps.join(" "), /Unconfirmed course/);
  assert.equal(
    fixture.reviewRequests.length,
    1,
    "normalizing a contradictory decision adds no model call",
  );
});

test("an existing unselected PDF is recovered by its actual ID without another generation or bypassing its review", async (t) => {
  let fileId = "",
    receiptId = "",
    generations = 0;
  const url = "https://courses.example/open";
  const fixture = await modelFixture(
    t,
    (i) => {
      if (i === 5) {
        const messages = JSON.parse(fixture.requests[i].body).input;
        const output = JSON.parse(
          messages.findLast((item: { type: string }) => item.type === "function_call_output")
            .output,
        );
        assert.equal(output.continuation, "artifact_selection");
        assert.deepEqual(
          output.availableFiles.map((file: { fileId: string }) => file.fileId),
          [fileId],
        );
        assert.equal(output.availableFiles[0].mimeType, "application/pdf");
        assert.doesNotMatch(
          output.instruction,
          /file has not been created|then create the requested file/i,
        );
        assert.equal(
          fixture.reviewRequests.length,
          0,
          "an empty selection is not the selected content",
        );
      }
      return [
        { name: "web_fetch", arguments: { url } },
        {
          name: "create_document",
          arguments: {
            name: "Open-course",
            format: "pdf",
            operationId: "once",
            content: `# Open AI\n\nAll lessons are free. Two hours, English. Optional certificate: paid.\n\nSource: ${url}`,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: { summary: "The comparison is ready.", artifactIds: [], outcome: "partial" },
        },
        {
          name: "finish_task",
          arguments: { summary: "The comparison PDF is attached.", artifactIds: [fileId] },
        },
      ][i];
    },
    {
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
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  await f.files.importAttachment("another-owner", "Private.txt", Buffer.from("Private"), "private");
  await f.files.importAttachment("owner", "Unrelated.txt", Buffer.from("Other task"), "other task");
  t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: "<main>All lessons are free. Two hours, English. Optional certificate: paid.</main>",
  }));
  const create = f.agent.media.createDocument.bind(f.agent.media);
  t.mock.method(f.agent.media, "createDocument", async (...args: Parameters<typeof create>) => {
    const result = await create(...args);
    fileId = result.fileId;
    generations++;
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
      "Research a free AI course and deliver a PDF comparing duration, language and certificate cost.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(generations, 1);
  assert.equal(fixture.reviewRequests.length, 1);
  assert.deepEqual(saved.artifactIds, [fileId]);
  assert.deepEqual((saved.state.executorModelExecution as { models: string[] }).models, [
    "openai/fixture",
  ]);
  assert.equal((saved.state.researchDeliveryReview as { model: string }).model, "openai/fixture");
});

test("incomplete access normalization preserves exhausted paths and existing-evidence repairs while rejecting fabricated free proof", async (t) => {
  const sourceUrl = "https://academy.example/course";
  const decisions = [
    {
      complete: false,
      blocked: true,
      needsMoreResearch: false,
      missing: ["Authorized sources exhausted"],
      nextSteps: [],
      accessAudit: [{ option: "Unavailable course", access: "unknown", sourceUrl }],
    },
    {
      complete: false,
      needsMoreResearch: false,
      missing: ["Correct the selected options"],
      nextSteps: ["Use the already verified alternative"],
      accessAudit: [
        { option: "Subscription course", access: "paid", sourceUrl },
        { option: "Trial course", access: "trial", sourceUrl },
      ],
    },
    {
      complete: false,
      needsMoreResearch: true,
      missing: ["Correct duration"],
      nextSteps: ["Correct the duration cell"],
      accessAudit: [
        {
          option: "Fabricated free course",
          access: "free",
          sourceUrl,
          quote: "All content is free without a subscription.",
        },
      ],
    },
  ];
  const fixture = await modelFixture(t, () => undefined, {
    researchReview: (_body, i) => decisions[i],
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Compare free generative AI courses." });
  const common = {
    task,
    summary: "Draft comparison",
    model: "openai/fixture",
    stage: "access_selection" as const,
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: {},
        receipt: { url: sourceUrl, text: "Preview. Subscribe for the full course." },
      },
    ] as never,
  };
  const exhausted = await reviewResearchDelivery(common);
  assert.equal(exhausted.blocked, true);
  assert.equal(exhausted.needsMoreResearch, false);
  assert.deepEqual(exhausted.nextSteps, []);
  assert.match(exhausted.missing.join(" "), /Unavailable course/);
  const repair = await reviewResearchDelivery(common);
  assert.equal(repair.complete, false);
  assert.equal(
    repair.needsMoreResearch,
    false,
    "known paid/trial access can be replaced using an already verified alternative",
  );
  assert.match(repair.nextSteps.join(" "), /Subscription course/);
  assert.match(repair.nextSteps.join(" "), /Trial course/);
  const fabricated = await reviewResearchDelivery(common);
  assert.equal(fabricated.complete, false);
  assert.match(fabricated.missing.join(" "), /Fabricated free course/);
  assert.equal(fabricated.accessGaps.length, 1);
  assert.equal(
    fixture.reviewRequests.length,
    3,
    "an already incomplete review does not add an expensive proof-only retry",
  );
});

test("factual review retains source truncation and exact recovery metadata instead of presenting excerpts as whole pages", async (t) => {
  await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
      const source = input.observations[0];
      assert.equal(source.truncated, true);
      assert.equal(source.sourceLength, 60000);
      assert.equal(source.spill.fileId, "a".repeat(64));
      assert.equal(source.spill.truncated, false);
      assert.equal(source.nextOffset, 1000);
      assert.match(
        JSON.parse(body).instructions,
        /truncated.*(?:absence|not stated|not published)/i,
      );
      return {
        complete: false,
        needsMoreResearch: false,
        missing: ["Course-specific language and duration remain unread"],
        nextSteps: ["Search the preserved full text for the course title"],
      };
    },
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Compare a free course's language and duration.",
  });
  const decision = await reviewResearchDelivery({
    task,
    summary: "Language and duration are not stated.",
    stage: "access_selection",
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://academy.example/credentials" },
        receipt: {
          url: "https://academy.example/credentials",
          text: "Earlier credentials...",
          truncated: true,
          sourceLength: 60000,
          nextOffset: 1000,
          spill: { fileId: "a".repeat(64), truncated: false },
        },
      },
    ] as never,
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
  });
  assert.equal(decision.complete, false);
  assert.equal(decision.needsMoreResearch, false);
});

test("document review distinguishes the actual delivered claim from a source's known fee and unpublished price", async (t) => {
  const draft = "Open course. Certificate: payment conditions are not stated; check enrollment.";
  const sourceText =
    "All course lessons are free. A non-refundable fee applies to the completion certificate. The fee amount is not published.";
  await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      const wire = JSON.parse(body);
      const input = JSON.parse(wire.input[0].content[0].text);
      assert.equal(input.proposedAnswer, draft);
      assert.equal(input.observations[0].text, sourceText);
      const keys = Object.keys(input);
      assert.ok(
        keys.indexOf("observations") < keys.indexOf("proposedAnswer"),
        "the selected answer remains distinct and visible after long source evidence",
      );
      assert.match(wire.instructions, /DELIVERED_CONTENT_GROUNDING/);
      assert.match(
        wire.instructions,
        /(?:unknown|unpublished).*amount.*(?:known|published).*billing/i,
      );
      return {
        complete: false,
        needsMoreResearch: false,
        requestAudit: [
          {
            requirement: "Say whether the certificate is paid",
            scope: "content",
            satisfied: false,
            evidence:
              "The draft calls payment conditions unknown, although the source explicitly states a certificate fee.",
          },
        ],
        missing: ["The selected draft omits the known certificate fee"],
        nextSteps: ["Correct the existing certificate cell to paid; leave only its amount unknown"],
      };
    },
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Compare a free course and say whether its certificate is paid.",
  });
  const decision = await reviewResearchDelivery({
    task,
    summary: draft,
    proposedDocument: true,
    stage: "access_selection",
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://academy.example/course" },
        receipt: { url: "https://academy.example/course", text: sourceText, truncated: false },
      },
    ] as Parameters<typeof reviewResearchDelivery>[0]["operations"],
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
  });
  assert.equal(decision.complete, false);
  assert.equal(decision.needsMoreResearch, false);
  assert.match(decision.nextSteps[0], /Correct the existing certificate cell/);
});

test("document preflight defers only file delivery while retaining factual and access failures", async (t) => {
  const fixture = await modelFixture(t, () => undefined, {
    researchReview: (_body, i) => ({
      complete: false,
      missing:
        i === 1 ? ["Free access is unknown", "PDF not yet delivered"] : ["PDF not yet delivered"],
      nextSteps: ["Deliver the PDF"],
      needsMoreResearch: true,
      requestAudit: [
        {
          requirement:
            i === 3
              ? "scope:content — Course content and free access"
              : "Course content and free access",
          satisfied: i !== 1,
          ...(i === 3 ? {} : { scope: "content" }),
          evidence: i === 1 ? "Unknown access" : "The full course is free.",
        },
        {
          requirement: i >= 3 ? "scope:delivery — Deliver PDF" : "Deliver PDF",
          satisfied: false,
          ...(i === 3 ? {} : { scope: i === 4 ? "content" : "delivery" }),
          evidence: "PDF not yet delivered",
        },
      ],
      accessAudit: [
        {
          option: "Open course",
          access: "free",
          sourceUrl: "https://courses.example/open",
          quote: "The full course is free.",
        },
      ],
    }),
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Research a free course and deliver a PDF.",
  });
  const common = {
    task,
    summary: "Open course: the full course is free.",
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection" as const,
    signal: new AbortController().signal,
    operations: [
      {
        id: "read",
        taskId: task.id,
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://courses.example/open" },
        receipt: { url: "https://courses.example/open", text: "The full course is free." },
      },
    ] as never,
  };
  const beforeRendering = await reviewResearchDelivery({ ...common, proposedDocument: true });
  assert.equal(beforeRendering.complete, true);
  assert.deepEqual(beforeRendering.missing, []);
  const unsupportedContent = await reviewResearchDelivery({ ...common, proposedDocument: true });
  assert.equal(unsupportedContent.complete, false);
  assert.ok(unsupportedContent.missing.includes("Course content and free access"));
  const actualDelivery = await reviewResearchDelivery(common);
  assert.equal(actualDelivery.complete, false);
  assert.ok(actualDelivery.missing.includes("Deliver PDF"));
  const labeledScopes = await reviewResearchDelivery({ ...common, proposedDocument: true });
  assert.equal(
    labeledScopes.complete,
    true,
    "an explicit delivery label cannot create a circular pre-render requirement",
  );
  assert.equal(labeledScopes.requestAudit[1].scope, "delivery");
  const explicitContent = await reviewResearchDelivery({ ...common, proposedDocument: true });
  assert.equal(
    explicitContent.complete,
    false,
    "an explicit content field takes priority over a conflicting delivery label",
  );
  assert.equal(fixture.reviewRequests.length, 5);
});

test("free-only recommendations repair unconfirmed access with the selected model even when optional review is disabled", async (t) => {
  let reviews = 0;
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://courses.example/premium" } },
        {
          name: "finish_task",
          arguments: {
            summary:
              "Free course: Premium AI. Certificate requires PRO; access price is unconfirmed.",
          },
        },
        { name: "web_fetch", arguments: { url: "https://courses.example/open" } },
        {
          name: "finish_task",
          arguments: {
            summary:
              "Open AI: the complete course is free. Its optional certificate costs €20. Source: https://courses.example/open",
          },
        },
      ][i],
    {
      researchReview: (body, i) => {
        reviews++;
        assert.match(body, /full requested content/i);
        assert.equal(JSON.parse(body).model, "fixture");
        return i === 0
          ? {
              complete: false,
              needsMoreResearch: true,
              missing: ["Premium AI full-course access has not been confirmed free"],
              nextSteps: [
                "Read the discovered alternative https://courses.example/open and verify full-course access separately from its certificate",
              ],
            }
          : {
              complete: true,
              needsMoreResearch: false,
              missing: [],
              nextSteps: [],
              accessAudit: [
                {
                  option: "Open AI",
                  access: "free",
                  sourceUrl: "https://courses.example/open",
                  quote: "All lessons and exercises are free with no trial or subscription.",
                },
              ],
            };
      },
    },
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  const reads: string[] = [];
  t.mock.method(f.agent.web, "document", async (url: string) => {
    reads.push(url);
    return {
      url,
      contentType: "text/html",
      body: url.endsWith("/premium")
        ? '<main>Free registration. Certificate and graded assignments require PRO. <a href="https://courses.example/open">Open AI course</a></main>'
        : "<main>All lessons and exercises are free with no trial or subscription. Optional certificate €20.</main>",
    };
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Pesquise um curso gratuito de IA generativa e diga se o certificado é pago.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(reviews, 2, "unverified access must be rejected before marking success");
  assert.deepEqual(reads, ["https://courses.example/premium", "https://courses.example/open"]);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.match(saved.result ?? "", /complete course is free/);
  assert.equal(saved.question, "");
  assert.equal(fixture.imageBriefRequests.length, 0);
});

test("a document wording repair stays a content correction through an unnecessary user question", async (t) => {
  let fileId = "",
    receiptId = "";
  const content = (certificate: string) =>
    `# Open AI\n\nAll lessons are free. The optional certificate ${certificate}.\n\nSource: https://courses.example/open`;
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://courses.example/open" } },
        {
          name: "create_document",
          arguments: {
            name: "Comparison",
            format: "pdf",
            content: content("is free"),
            operationId: "incorrect",
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: { summary: "Comparison attached.", artifactIds: [fileId] },
        },
        {
          name: "ask_user",
          arguments: { question: "Posso continuar pesquisando e trocar o curso?" },
        },
        {
          name: "create_document",
          arguments: {
            name: "Comparison",
            format: "pdf",
            content: content("costs €20"),
            operationId: "corrected",
            replaceFileId: fileId,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: { summary: "Comparison attached.", artifactIds: [fileId] },
        },
      ][i],
    {
      researchReview: (_body, i) => ({
        complete: i !== 0,
        needsMoreResearch: false,
        missing: i === 0 ? ["The certificate price in the document is incorrect"] : [],
        nextSteps:
          i === 0
            ? ["Correct only the certificate price to €20 using the already read source"]
            : [],
        accessAudit: [
          {
            option: "Open AI",
            access: "free",
            sourceUrl: "https://courses.example/open",
            quote: "All lessons are free.",
          },
        ],
      }),
    },
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>All lessons are free. The optional certificate costs €20.</main>",
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
    prompt: "Research a free AI course and deliver a PDF with its certificate price.",
  });
  await f.agent.worker.tick();
  const operations = await f.agent.journal.operations("owner", task.id);
  const correction = operations.find((op) => op.toolName === "finish_task")?.receipt as {
    instruction: string;
    needsMoreResearch: boolean;
  };
  const question = operations.find((op) => op.toolName === "ask_user")?.receipt as {
    status: string;
    instruction: string;
  };
  assert.equal(correction.needsMoreResearch, false);
  assert.doesNotMatch(correction.instruction, /Replace an unsuitable|Repair the failed options/);
  assert.equal(question.status, "continue_document_repair");
  assert.doesNotMatch(question.instruction, /Continue researching or replacing/);
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal(read.mock.callCount(), 1);
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 0);
  const extracted = await new FileLibrary(f.agent.files, f.db).read("owner", {
    fileId,
    offset: 0,
    limit: 10000,
  });
  assert.match(extracted.text, /certificate costs €20/);
  assert.equal(fixture.reviewRequests.length, 2);
});

test("an unqualified rendered PDF is withheld until its corrected bytes and pixels pass delivery", async (t) => {
  let fileId = "",
    receiptId = "";
  const rendered: string[] = [];
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://courses.example/premium" } },
        {
          name: "create_document",
          arguments: {
            name: "Courses",
            format: "pdf",
            operationId: "unverified",
            content: "Premium AI: free registration, full access unconfirmed.",
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: { summary: "Comparison attached.", artifactIds: [fileId] },
        },
        {
          name: "ask_user",
          arguments: {
            question: "Posso substituir a opção não confirmada por outro curso gratuito?",
          },
        },
        { name: "web_fetch", arguments: { url: "https://courses.example/open" } },
        {
          name: "create_document",
          arguments: {
            name: "Courses",
            format: "pdf",
            operationId: "verified",
            replaceFileId: fileId,
            content:
              "# Open AI\n\nAll lessons and exercises are free with no trial or subscription. Beginner generative AI, English, two hours. Optional certificate €20.\n\nSource: https://courses.example/open",
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: {
            summary: "The verified free-course PDF is attached.",
            artifactIds: [fileId],
          },
        },
      ][i],
    {
      researchReview: (_body, i) =>
        i === 0
          ? {
              complete: false,
              needsMoreResearch: true,
              missing: ["Premium AI full access is unconfirmed"],
              accessAudit: [
                {
                  option: "Premium AI",
                  access: "unknown",
                  sourceUrl: "https://courses.example/premium",
                  quote: "Free registration; full-course access requires a paid subscription.",
                },
              ],
              nextSteps: ["Read the actual free-content policy or replace this option in the PDF"],
            }
          : {
              complete: true,
              needsMoreResearch: false,
              missing: [],
              nextSteps: [],
              accessAudit: [
                {
                  option: "Open AI",
                  access: "free",
                  sourceUrl: "https://courses.example/open",
                  quote: "All lessons and exercises are free with no trial or subscription.",
                },
              ],
            },
    },
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.endsWith("/premium")
      ? "<main>Free registration; full-course access requires a paid subscription.</main>"
      : "<main>All lessons and exercises are free with no trial or subscription. Beginner generative AI, English, two hours. Optional certificate €20.</main>",
  }));
  const create = f.agent.media.createDocument.bind(f.agent.media);
  t.mock.method(f.agent.media, "createDocument", async (...args: Parameters<typeof create>) => {
    rendered.push((args[1] as { content: string }).content);
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
      "Research a free beginner generative AI course and deliver a PDF with language, duration and optional certificate cost.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    (await f.db.list("owner", "interaction-requests")).length,
    0,
    "replacing the agent's unqualified choice requires no new user answer",
  );
  assert.equal(rendered.length, 2, "a rejected local draft is replaced before delivery");
  assert.ok(rendered[1].includes("Open AI"));
  const rejectedOutput = JSON.parse(fixture.requests[5].body)
    .input.filter((item: { type: string }) => item.type === "function_call_output")
    .at(-1);
  assert.ok(rejectedOutput);
  const rejection = JSON.parse(rejectedOutput.output);
  assert.deepEqual(
    rejection.accessAudit,
    [
      {
        option: "Premium AI",
        access: "unknown",
        sourceUrl: "https://courses.example/premium",
        quote: "Free registration; full-course access requires a paid subscription.",
      },
    ],
    "the worker must receive the existing per-option assessment instead of guessing what to research again",
  );
  assert.ok(rejection.requestAudit?.length);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal(saved.completion?.status, "verified");
  assert.deepEqual(saved.artifactIds, [fileId]);
  assert.equal(
    fixture.reviewRequests.length,
    2,
    "each selected version is checked once against its actual delivered bytes",
  );
});

test("ordinary source lookup retains zero review calls when optional review is disabled", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://courses.example/description" } },
        { name: "finish_task", arguments: { summary: "The course has six lessons." } },
      ][i],
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>The course has six lessons.</main>",
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "How many lessons does this course have?",
  });
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "succeeded");
  assert.equal(fixture.reviewRequests.length, 0);
});

test("unchanged rejected document reuses its access review, while new source and replacement bytes allow completion", async (t) => {
  let fileId = "";
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://courses.example/premium" } },
        {
          name: "create_document",
          arguments: {
            name: "Comparison.md",
            format: "markdown",
            content: "Premium AI — access unconfirmed.",
            operationId: "draft",
          },
        },
        { name: "finish_task", arguments: { summary: "Premium AI is my selected free course." } },
        {
          name: "finish_task",
          arguments: { summary: "The same comparison remains attached; access has not changed." },
        },
        { name: "web_fetch", arguments: { url: "https://courses.example/open" } },
        {
          name: "create_document",
          arguments: {
            name: "Comparison.md",
            format: "markdown",
            content:
              "Open AI — all lessons and exercises are free with no trial or subscription. Optional certificate €20. https://courses.example/open",
            operationId: "replacement",
            replaceFileId: fileId,
          },
        },
        {
          name: "finish_task",
          arguments: { summary: "Open AI comparison attached with free access verified." },
        },
      ][i],
    {
      researchReview: (_body, i) =>
        i === 0
          ? {
              complete: false,
              needsMoreResearch: true,
              missing: ["Premium AI free access unconfirmed"],
              nextSteps: ["Read the observed Open AI alternative and replace the comparison"],
              accessAudit: [
                {
                  option: "Premium AI",
                  access: "unknown",
                  sourceUrl: "https://courses.example/premium",
                  quote: "Certificate requires PRO; access unconfirmed.",
                },
              ],
            }
          : {
              complete: true,
              needsMoreResearch: false,
              missing: [],
              nextSteps: [],
              accessAudit: [
                {
                  option: "Open AI",
                  access: "free",
                  sourceUrl: "https://courses.example/open",
                  quote: "All lessons and exercises are free with no trial or subscription.",
                },
              ],
            },
    },
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.endsWith("/premium")
      ? "<main>Certificate requires PRO; access unconfirmed.</main>"
      : "<main>All lessons and exercises are free with no trial or subscription. Optional certificate €20.</main>",
  }));
  const original = f.files.importAttachment.bind(f.files);
  t.mock.method(f.files, "importAttachment", async (...args: Parameters<typeof original>) => {
    const file = await original(...args);
    if (!fileId && file.name === "Comparison.md") fileId = file.id;
    return file;
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Compare a free AI course in a Markdown document and state the certificate price.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.equal(
    fixture.reviewRequests.length,
    2,
    "same rejected bytes cannot trigger a second reviewer call",
  );
  assert.equal((saved.state.researchDeliveryReview as { attempts: number }).attempts, 2);
  const rejectedOutput = JSON.parse(fixture.requests[3].body)
    .input.filter((item: { type: string }) => item.type === "function_call_output")
    .at(-1);
  assert.ok(rejectedOutput);
  assert.equal(JSON.parse(rejectedOutput.output).accessAudit?.[0]?.option, "Premium AI");
  assert.ok(fileId);
  assert.equal(saved.artifactIds.length, 1);
  assert.notEqual(saved.artifactIds[0], fileId);
});

test("wording-only rejection remains bound to the actual document until its bytes or evidence change", async (t) => {
  let originalFile = "";
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://courses.example/open" } },
        {
          name: "create_document",
          arguments: {
            name: "Comparison.md",
            format: "markdown",
            content: "Open AI: all lessons are free. The certificate is free.",
            operationId: "draft",
          },
        },
        { name: "finish_task", arguments: { summary: "Free course and certificate attached." } },
        {
          name: "finish_task",
          arguments: {
            summary: "Corrected comparison attached: Open AI is free; certificate €20.",
          },
        },
        {
          name: "finish_task",
          arguments: { summary: "The PDF was corrected. The optional certificate costs €20." },
        },
        {
          name: "create_document",
          arguments: {
            name: "Comparison.md",
            format: "markdown",
            content: "Open AI: all lessons are free. The optional certificate costs €20.",
            operationId: "corrected",
            replaceFileId: originalFile,
          },
        },
        { name: "finish_task", arguments: { summary: "Corrected comparison attached." } },
      ][i],
    {
      researchReview: (_body, i) => ({
        complete: i !== 0,
        needsMoreResearch: false,
        missing: i === 0 ? ["The document wrongly calls the certificate free"] : [],
        nextSteps: i === 0 ? ["Correct the document: the certificate costs €20"] : [],
        accessAudit: [
          {
            option: "Open AI",
            access: "free",
            sourceUrl: "https://courses.example/open",
            quote: "All lessons are free.",
          },
        ],
      }),
    },
  );
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>All lessons are free. The optional certificate costs €20.</main>",
  }));
  const importFile = f.files.importAttachment.bind(f.files);
  t.mock.method(f.files, "importAttachment", async (...args: Parameters<typeof importFile>) => {
    const file = await importFile(...args);
    if (!originalFile && file.name === "Comparison.md") originalFile = file.id;
    return file;
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Compare a free AI course in a Markdown document and state the certificate price.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "succeeded",
    JSON.stringify({
      result: saved.result,
      completion: saved.completion,
      review: saved.state.researchDeliveryReview,
      operations: (await f.agent.journal.operations("owner", task.id)).map((op) => ({
        name: op.toolName,
        args: op.args,
        status: op.status,
        receipt: op.receipt,
      })),
    }),
  );
  assert.notEqual(
    saved.artifactIds[0],
    originalFile,
    "promising a correction cannot deliver the previously rejected document",
  );
  assert.equal(fixture.reviewRequests.length, 2, "unchanged rejected bytes reuse their rejection");
  const document = await f.files.bytes("owner", saved.artifactIds[0]);
  assert.match(Buffer.from(document).toString(), /certificate costs €20/);
  for (const i of [3, 4, 5])
    assert.match(fixture.requests[i].body, /Correct the document: the certificate costs €20/);
});

test("a researched PDF has one factual check on its actual reviewed bytes, not a second pre-render review", async (t) => {
  let fileId = "",
    receiptId = "",
    generations = 0,
    visualReviews = 0;
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://courses.example/open" } },
        {
          name: "create_document",
          arguments: {
            name: "Open-course",
            format: "pdf",
            operationId: "draft",
            content:
              "# Open AI\n\nAll lessons are free. English, two hours, optional certificate €20.\n\nSource: https://courses.example/open",
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
      researchReview: (body) => {
        assert.equal(generations, 1, "facts are checked against the actual created document");
        assert.equal(visualReviews, 1, "delivery retains its required visual inspection");
        const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
        assert.equal(input.proposedDocument, false);
        assert.deepEqual(input.artifacts, [fileId]);
        assert.equal(input.documents.length, 1);
        assert.match(input.documents[0].text, /optional certificate €20/);
        return {
          complete: true,
          missing: [],
          nextSteps: [],
          accessAudit: [
            {
              option: "Open AI",
              access: "free",
              sourceUrl: "https://courses.example/open",
              quote: "All lessons are free.",
            },
          ],
        };
      },
    },
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>All lessons are free. English, two hours, optional certificate €20.</main>",
  }));
  const create = f.agent.media.createDocument.bind(f.agent.media);
  t.mock.method(f.agent.media, "createDocument", async (...args: Parameters<typeof create>) => {
    const result = await create(...args);
    generations++;
    fileId = result.fileId;
    return result;
  });
  const inspect = f.agent.media.inspectDocument.bind(f.agent.media);
  t.mock.method(f.agent.media, "inspectDocument", async (...args: Parameters<typeof inspect>) => {
    const result = await inspect(...args);
    visualReviews++;
    receiptId = result.receiptId;
    return result;
  });
  const task = await f.agent.createTask("owner", {
    prompt:
      "Research a free AI course and deliver a PDF comparing language, duration and optional certificate cost.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(fixture.reviewRequests.length, 1);
  assert.equal(read.mock.callCount(), 1);
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 0);
  assert.deepEqual(saved.artifactIds, [fileId]);
});

test("the executor and final PDF review receive the fetched FAQ without another fetch, generation or journal mutation", async (t) => {
  const url = "https://courses.example/beginners";
  const freeProof =
    "All lessons in Beginners AI are free; the optional certificate requires a non-refundable fee.";
  let fileId = "",
    receiptId = "";
  const fixture = await modelFixture(
    t,
    (i) => {
      if (i === 1) {
        const input = JSON.parse(fixture.requests[i].body).input;
        const receipt = JSON.parse(
          input.findLast((item: { type: string }) => item.type === "function_call_output").output,
        );
        assert.ok(
          receipt.text.includes(freeProof),
          "the worker must see the certificate FAQ before its first document generation",
        );
        assert.equal(receipt.truncated, false);
        assert.equal(receipt.sourceRecovery.networkRead, false);
      }
      return [
        { name: "web_fetch", arguments: { url, maxChars: 6000 } },
        {
          name: "create_document",
          arguments: {
            name: "Beginners-AI",
            format: "pdf",
            operationId: "faq-comparison",
            content: `# Beginners AI\n\nFree lessons. English, two hours. Optional certificate: paid; price not published.\n\nSource: ${url}`,
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: { summary: "The course PDF is attached.", artifactIds: [fileId] },
        },
      ][i];
    },
    {
      researchReview: (body) => {
        const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
        const source = input.observations.find((op: { tool: string }) => op.tool === "web_fetch");
        assert.ok(
          source.text.includes(freeProof),
          "the reviewer receives the FAQ already preserved beyond 6,000 characters",
        );
        assert.equal(source.truncated, false);
        assert.equal(source.sourceRecovery.networkRead, false);
        assert.equal(source.sourceRecovery.sha256, source.spill.sha256);
        assert.match(input.documents[0].text, /Optional certificate: paid/);
        return {
          complete: true,
          missing: [],
          nextSteps: [],
          accessAudit: [
            { option: "Beginners AI", access: "free", sourceUrl: url, quote: freeProof },
          ],
        };
      },
    },
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  const read = t.mock.method(f.agent.web, "document", async () => ({
    url,
    contentType: "text/html",
    body: `<main><h1>Beginners AI</h1><p>English. Two hours.</p><h2>Another course: Advanced AI Pro</h2><p>Get this other course with a subscription.</p><p>${"Student review. ".repeat(900)}</p><h2>Beginners AI FAQ</h2><p>${freeProof}</p></main>`,
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
      "Research a free beginner AI course and deliver a PDF comparing language, duration and whether its certificate is paid.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(
    fixture.reviewRequests.length,
    1,
    "an exact quote from the recovered FAQ needs no proof correction call",
  );
  assert.equal(read.mock.callCount(), 1);
  const operations = await f.agent.journal.operations("owner", task.id);
  assert.equal(operations.filter((op) => op.toolName === "create_document").length, 1);
  const fetched = operations.find((op) => op.toolName === "web_fetch")!.receipt as {
    text: string;
    truncated: boolean;
    spill: { fileId: string };
    sourceRecovery?: unknown;
  };
  assert.equal(
    fetched.text.length,
    6000,
    "the actual caller's requested excerpt remains immutable",
  );
  assert.equal(fetched.truncated, true);
  assert.equal(
    fetched.sourceRecovery,
    undefined,
    "hydration is only a reasoning/review projection, not a rewritten receipt",
  );
  assert.ok(fetched.spill.fileId);
  assert.equal((await f.db.list("owner", "interaction-requests")).length, 0);
});

test("an unavailable final document check resumes its saved reviewed file without generating or reading again", async (t) => {
  let unavailable = true,
    fileId = "",
    receiptId = "",
    generations = 0;
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://courses.example/open" } },
        {
          name: "create_document",
          arguments: {
            name: "Open-course",
            format: "pdf",
            operationId: "once",
            content:
              "# Open AI\n\nAll lessons and exercises are free with no trial or subscription. English, two hours, optional certificate €20.\n\nSource: https://courses.example/open",
          },
        },
        { name: "inspect_document", arguments: { fileId, pageCount: 4 } },
        { name: "confirm_document_review", arguments: { receiptId, passed: true, issues: [] } },
        {
          name: "finish_task",
          arguments: {
            summary: "The verified free-course PDF is attached.",
            artifactIds: [fileId],
          },
        },
      ][i],
    {
      reviewErrorStatus: () => (unavailable ? 503 : undefined),
      researchReview: () => ({
        complete: true,
        missing: [],
        nextSteps: [],
        accessAudit: [
          {
            option: "Open AI",
            access: "free",
            sourceUrl: "https://courses.example/open",
            quote: "All lessons and exercises are free with no trial or subscription.",
          },
        ],
      }),
    },
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  f.agent.config.modelProviders!.routing!.maxAttempts = 1;
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>All lessons and exercises are free with no trial or subscription. English, two hours, optional certificate €20.</main>",
  }));
  const create = f.agent.media.createDocument.bind(f.agent.media);
  t.mock.method(f.agent.media, "createDocument", async (...args: Parameters<typeof create>) => {
    generations++;
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
      "Research a free AI course and deliver a PDF comparing language, duration and optional certificate cost.",
  });
  await f.agent.worker.tick();
  let saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "waiting_provider");
  assert.equal(generations, 1);
  assert.deepEqual(saved.artifactIds, [fileId]);
  assert.deepEqual(
    (await f.agent.detail("owner", task.id)).files,
    [],
    "an unverified draft is withheld from delivery",
  );
  assert.ok(saved.state.pendingResearchDelivery);
  assert.equal(fixture.requests.length, 5);
  unavailable = false;
  const { sharedModelRouter } = await import("../apps/server/src/providers/model-router.ts");
  const cooldown = sharedModelRouter(f.agent.config.modelProviders!).health.get(
    "openai/fixture",
  ).cooldownUntil;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, cooldown - Date.now() + 5)));
  await f.db.put("owner", "tasks", { ...saved, nextRunAt: new Date(0).toISOString() });
  await f.agent.worker.tick();
  saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question ?? saved.result);
  assert.equal(generations, 1);
  assert.equal(read.mock.callCount(), 1);
  assert.deepEqual(saved.artifactIds, [fileId]);
  assert.equal(saved.state.pendingResearchDelivery, null);
  assert.equal(
    fixture.requests.length,
    5,
    "resuming a saved final check does not restart the agent's work",
  );
});

test("selection review checks the selected replacement document and omits discarded drafts", async (t) => {
  let reviewed = false;
  await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
      assert.equal(input.artifactCreation.length, 1);
      assert.equal(input.artifactCreation[0].args.content, "Open course: all lessons are free.");
      reviewed = true;
      return { complete: true, missing: [], nextSteps: [] };
    },
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Compare free AI courses in a PDF." });
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  await reviewResearchDelivery({
    task: { ...task, artifactIds: ["corrected-pdf"] },
    summary: "Corrected comparison attached.",
    operations: [
      {
        toolName: "create_document",
        status: "succeeded",
        args: { content: "Premium course with unconfirmed access." },
        receipt: { fileId: "discarded-pdf" },
      },
      {
        toolName: "create_document",
        status: "succeeded",
        args: { content: "Open course: all lessons are free." },
        receipt: { fileId: "corrected-pdf" },
      },
    ] as Parameters<typeof reviewResearchDelivery>[0]["operations"],
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection",
    signal: new AbortController().signal,
  });
  assert.equal(reviewed, true);
});

test("access review cannot certify free access from absence of pricing or a fabricated source quote", async (t) => {
  await modelFixture(t, () => undefined, {
    researchReview: () => ({
      complete: true,
      missing: [],
      nextSteps: [],
      accessAudit: [
        {
          option: "Premium AI",
          access: "free",
          sourceUrl: "https://courses.example/premium",
          quote: "The complete course is free with no subscription.",
        },
      ],
    }),
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Recommend a free course." });
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  const decision = await reviewResearchDelivery({
    task,
    summary: "Premium AI is free; no fee was displayed.",
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://courses.example/premium" },
        receipt: {
          url: "https://courses.example/premium",
          text: "Create your account. Certificate and assessments require PRO.",
        },
      },
    ] as Parameters<typeof reviewResearchDelivery>[0]["operations"],
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection",
    signal: new AbortController().signal,
  });
  assert.equal(
    decision.complete,
    false,
    "a reviewer assertion is not observed eligibility evidence",
  );
  assert.equal(decision.blocked, false);
  assert.equal(decision.needsMoreResearch, true);
  assert.match(decision.missing.join(" "), /Premium AI/);
});

test("a missing researched file continues authoring without treating navigation links as missing facts", async (t) => {
  const content = "Open AI: all lessons are free; two hours. Source: https://courses.example/open";
  const fixture = await modelFixture(
    t,
    (i) => {
      if (i === 2) {
        const input = JSON.parse(fixture.requests[i].body).input;
        const previous = JSON.parse(
          input.findLast((item: { type: string }) => item.type === "function_call_output").output,
        );
        assert.equal(previous.complete, false);
        assert.equal(previous.repairable, true);
        assert.equal(previous.unreadSourceLinks, undefined);
        assert.match(previous.instruction, /create.*file|create_document/i);
        assert.ok(offeredHostTools(fixture.requests[i].body).includes("web_fetch"));
        assert.equal(fixture.reviewRequests.length, 0, "do not review a nonexistent document");
      }
      return [
        { name: "web_fetch", arguments: { url: "https://courses.example/open" } },
        {
          name: "finish_task",
          arguments: {
            outcome: "partial",
            summary: "Research is ready; I still need to create the file.",
          },
        },
        {
          name: "create_document",
          arguments: { name: "Course.md", format: "markdown", content, operationId: "course" },
        },
        { name: "finish_task", arguments: { summary: "The course comparison is attached." } },
      ][i];
    },
    {
      researchReview: (body) => {
        const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
        assert.equal(input.documents.length, 1);
        assert.equal(input.documents[0].text, content);
        return {
          complete: true,
          needsMoreResearch: false,
          missing: [],
          nextSteps: [],
          accessAudit: [
            {
              option: "Open AI",
              access: "free",
              sourceUrl: "https://courses.example/open",
              quote: "All lessons are free.",
            },
          ],
        };
      },
    },
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: '<main>Open AI. All lessons are free. Two hours. <a href="/privacy">Privacy</a></main>',
  }));
  const task = await f.agent.createTask("owner", {
    prompt:
      "Pesquise um curso gratuito introdutório e entregue um arquivo Markdown com sua duração.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.equal(saved.completion?.status, "verified");
  assert.equal(saved.artifactIds.length, 1);
  assert.equal(fixture.reviewRequests.length, 1);
});

test("free-access delivery reaches its focused review instead of treating unrelated navigation as unfinished research", async (t) => {
  let reviews = 0;
  await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://courses.example/private-course" } },
        {
          name: "create_document",
          arguments: {
            name: "Access report.md",
            format: "markdown",
            content: "The course access conditions could not be confirmed.",
            operationId: "access-report",
          },
        },
        {
          name: "finish_task",
          arguments: {
            outcome: "partial",
            summary:
              "The named course requires private access to verify its terms. The report states the limitation.",
          },
        },
      ][i],
    {
      researchReview: (body) => {
        reviews++;
        const request = JSON.parse(body);
        const input = JSON.parse(request.input[0].content[0].text);
        assert.equal(
          input.documents.length,
          1,
          "the reviewer must read the selected artifact's actual content",
        );
        assert.equal(input.documents[0].name, "Access report.md");
        assert.equal(
          input.documents[0].text,
          "The course access conditions could not be confirmed.",
        );
        assert.equal(input.documents[0].nextOffset, null);
        assert.doesNotMatch(request.instructions, /Inspect actual pixels rather than certifying/);
        return {
          complete: false,
          blocked: true,
          needsMoreResearch: true,
          missing: ["The named course access conditions require private authentication"],
          nextSteps: [],
        };
      },
    },
  );
  const f = await baseTaskRuntime(t, {
    agentBackend: "model",
    model: "openai/fixture",
    researchReviewEnabled: false,
  });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: '<main>Course detail requires an account invitation. <a href="https://courses.example/privacy">Privacy policy</a></main>',
  }));
  const task = await f.agent.createTask("owner", {
    prompt:
      "Pesquise o curso gratuito Example e entregue um arquivo Markdown com suas condições de acesso.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(reviews, 1, "navigation links cannot bypass the active fact reviewer");
  assert.equal(saved.status, "failed");
  assert.notEqual(saved.completion?.status, "verified");
});

test("a review cannot certify a comparison while its request audit identifies missing entities", async (t) => {
  await modelFixture(t, () => undefined, {
    researchReview: () => ({
      complete: true,
      needsMoreResearch: true,
      missing: [],
      nextSteps: ["Read the second candidate's values and revise the image"],
      requestAudit: [
        {
          requirement: "Both candidates' percentages in each region",
          satisfied: false,
          evidence: "The image shows only the regional winner's percentage",
        },
      ],
    }),
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Create a map showing candidate A and candidate B percentages in each region.",
  });
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  const providers = f.agent.config.modelProviders;
  assert.ok(providers);
  const decision = await reviewResearchDelivery({
    task,
    summary: "Map of each region's winner.",
    operations: [],
    model: "openai/fixture",
    providers,
    structured: false,
    signal: new AbortController().signal,
  });
  assert.equal(decision.complete, false);
  assert.match(decision.missing.join(" "), /Both candidates/);
  assert.equal(decision.blocked, false, "a concrete repair path keeps work active");
});

test("a valid comparison audit with more than twelve requirements is not treated as a provider outage", async (t) => {
  const audit = Array.from({ length: 21 }, (_, i) => ({
    requirement: `Course ${Math.floor(i / 7) + 1}, category ${i % 7}`,
    satisfied: i !== 20,
    evidence: i === 20 ? "The requested duration is missing" : "Observed official source content",
  }));
  await modelFixture(t, () => undefined, {
    researchReview: () => ({
      complete: true,
      needsMoreResearch: false,
      missing: [],
      nextSteps: [],
      requestAudit: audit,
    }),
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Compare three courses across seven categories.",
  });
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  const decision = await reviewResearchDelivery({
    task,
    summary: "The comparison is complete",
    operations: [],
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
  });
  assert.equal(decision.requestAudit.length, 21);
  assert.equal(decision.complete, false, "the unsatisfied requirement still rejects the delivery");
  assert.match(decision.missing.join(" "), /Course 3, category 6/);
});

test("delivery review preserves facts in the middle of a source that fits the configured model", async (t) => {
  let observed = "";
  await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      const payload = JSON.parse(JSON.parse(body).input[0].content[0].text);
      observed = payload.observations[0].text;
      return { complete: true, missing: [], nextSteps: [] };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "What are the current percentages?" });
  const source =
    "Historical coverage. ".repeat(700) +
    "Candidate A: 52%; Candidate B: 48%." +
    " More coverage.".repeat(700);
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  await reviewResearchDelivery({
    task,
    summary: "Candidate A: 52%; Candidate B: 48%.",
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://news.example/live" },
        receipt: { url: "https://news.example/live", text: source },
      },
    ] as Parameters<typeof reviewResearchDelivery>[0]["operations"],
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
  });
  assert.equal(
    observed,
    source,
    "review must receive the complete source rather than lose its middle to a fixed character cap",
  );
});

test("infographic review receives actual file pixels and discovered links beyond navigation entries", async (t) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
    "base64",
  );
  let checked = false;
  await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://news.example/results" } },
        { name: "generate_image", arguments: { prompt: "A map with results", operationId: "map" } },
        {
          name: "finish_task",
          arguments: {
            summary: "The map is attached, but its regional values are missing.",
            outcome: "partial",
          },
        },
      ][i],
    {
      researchReview: (body) => {
        const input = JSON.parse(body).input;
        checked =
          input.some(
            (message: { content?: { type: string; image_url?: string }[] }) =>
              Array.isArray(message.content) &&
              message.content.some(
                (part) =>
                  part.type === "input_image" &&
                  part.image_url === `data:image/png;base64,${png.toString("base64")}`,
              ),
          ) && body.includes("https://news.example/region-26");
        return {
          complete: false,
          blocked: true,
          missing: ["The observed image lacks the requested regional results"],
          nextSteps: [],
        };
      },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: `<main>Current results: A 52%, B 48%.${Array.from({ length: 27 }, (_, i) => `<a href="/region-${i}">Region ${i}</a>`).join("")}</main>`,
  }));
  t.mock.method(f.agent.media, "generatedImage", async () => {
    const file = await f.files.importAttachment(
      "owner",
      "map.png",
      png,
      "Generated image",
      "image/png",
    );
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Crie um infográfico com um mapa e os resultados por região.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.ok(checked);
  assert.equal(saved.status, "failed");
  assert.equal(saved.artifactIds.length, 1);
  assert.notEqual(saved.completion?.status, "verified");
});

test("an explicit partial result cannot bypass available research recovery", async (t) => {
  const calls = [
    { name: "web_fetch", arguments: { url: "https://official.example/about" } },
    {
      name: "finish_task",
      arguments: { summary: "The official page has no count.", outcome: "partial" },
    },
    { name: "web_fetch", arguments: { url: "https://news.example/live" } },
    {
      name: "finish_task",
      arguments: {
        summary: "Count: A 52%, B 48%. Source: https://news.example/live",
        outcome: "completed",
      },
    },
  ];
  await modelFixture(t, (i) => calls[i], {
    researchReview: (_body, i) =>
      i === 0
        ? {
            complete: false,
            needsMoreResearch: true,
            missing: ["The current count"],
            nextSteps: ["Read the returned alternative https://news.example/live"],
          }
        : { complete: true, needsMoreResearch: false, missing: [], nextSteps: [] },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const urls: string[] = [];
  t.mock.method(f.agent.web, "document", async (url: string) => {
    urls.push(url);
    return {
      url,
      contentType: "text/html",
      body: url.includes("official.example")
        ? '<article>Election calendar. <a href="https://news.example/live">Live count</a></article>'
        : "<main>A 52%, B 48%.</main>",
    };
  });
  const task = await f.agent.createTask("owner", { prompt: "What is the current count?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.deepEqual(urls, ["https://official.example/about", "https://news.example/live"]);
  assert.match(saved.result ?? "", /52%/);
  assert.equal(saved.completion?.status, "verified");
});

test("new research observations keep the worker moving beyond three delivery reviews", async (t) => {
  const calls = Array.from({ length: 5 }, (_, i) => [
    { name: "web_fetch", arguments: { url: `https://news.example/part-${i}` } },
    {
      name: "finish_task",
      arguments: {
        summary: `Observed section ${i}; source https://news.example/part-${i}`,
        outcome: "completed",
      },
    },
  ]).flat();
  let reviews = 0;
  await modelFixture(t, (i) => calls[i], {
    researchReview: (_body, i) => {
      reviews++;
      return i < 4
        ? {
            complete: false,
            needsMoreResearch: true,
            missing: ["More requested sections"],
            nextSteps: ["Read the next observed section"],
          }
        : { complete: true, needsMoreResearch: false, missing: [], nextSteps: [] };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: `<article>New observed section: ${url}</article>`,
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "What are the latest findings from these pages?",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "succeeded",
    JSON.stringify({
      completion: saved.completion,
      review: saved.state.researchDeliveryReview,
      operations: (await f.agent.journal.operations("owner", task.id)).map((op) => ({
        name: op.toolName,
        receipt: op.receipt,
      })),
    }),
  );
  assert.equal(reviews, 5);
});

test("research cannot finish with instructions to consult an unread results link; review sends it back to work", async (t) => {
  const calls = [
    { name: "web_fetch", arguments: { url: "https://news.example/about" } },
    {
      name: "finish_task",
      arguments: {
        summary: "I could not read the results. Check https://news.example/live",
        outcome: "completed",
      },
    },
    { name: "web_fetch", arguments: { url: "https://news.example/live" } },
    {
      name: "finish_task",
      arguments: {
        summary:
          "Current count:\n- Candidate A: 52%, 12345 votes.\nSource: https://news.example/live",
        outcome: "completed",
      },
    },
  ];
  let reviews = 0;
  await modelFixture(t, (i) => calls[i], {
    researchReview: (body, index) => {
      reviews++;
      assert.match(body, /how is the count/);
      return index === 0
        ? {
            complete: false,
            missing: ["The actual current count"],
            nextSteps: ["Read the live results link already returned by the source."],
          }
        : { complete: true, missing: [], nextSteps: [] };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.endsWith("/about")
      ? '<title>About</title><article>Counting starts today. <a href="/live">Live results</a></article>'
      : "<title>Live</title><main>Candidate A: 52%, 12345 votes</main>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "how is the count?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.match(saved.result ?? "", /12345/);
  assert.equal(reviews, 2);
});

test("an actual unresolved blocker remains partial after the model uses more than three repair attempts", async (t) => {
  const sources = ["official", "news-a", "news-b", "news-c", "archive"].map(
    (name) => `https://${name}.example/results`,
  );
  const calls = sources.flatMap((url, i) => [
    { name: "web_fetch", arguments: { url } },
    {
      name: "finish_task",
      arguments: {
        summary: "The consulted sources have not published the requested results.",
        outcome: i === 4 ? "partial" : "completed",
      },
    },
  ]);
  await modelFixture(t, (i) => calls[i], {
    researchReview: (_body, i) => ({
      complete: false,
      blocked: i >= 4,
      missing: ["Requested results remain absent"],
      nextSteps: i >= 4 ? [] : ["Try a relevant alternative data source"],
    }),
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const observed: string[] = [];
  t.mock.method(f.agent.web, "document", async (url: string) => {
    observed.push(url);
    return {
      url,
      contentType: "text/html",
      body: "<article>The requested results have not been published.</article>",
    };
  });
  const task = await f.agent.createTask("owner", { prompt: "What are the results now?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "failed");
  assert.notEqual(saved.completion?.status, "verified");
  assert.deepEqual(observed, sources);
  assert.ok(
    (await f.agent.journal.operations("owner", task.id)).filter((o) => o.toolName === "finish_task")
      .length >= 5,
  );
});

test("ending with plain text cannot bypass the research delivery review", async (t) => {
  await modelFixture(
    t,
    (i) =>
      i === 0 ? { name: "web_fetch", arguments: { url: "https://news.example/about" } } : undefined,
    {
      text: (i) => (i > 0 ? "Visit the website for the results." : undefined),
      researchReview: () => ({
        complete: false,
        missing: ["The count is absent"],
        nextSteps: ["Read the actual count"],
      }),
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<article>General election information.</article>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "What are the results?" });
  for (let i = 0; i < 3; i++) await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "queued",
    "incomplete prose stays repairable without a three-review cutoff",
  );
  assert.notEqual(saved.completion?.status, "verified");
});

test("the model reads discovered alternative sources after incomplete delivery reviews", async (t) => {
  let count = 0;
  await modelFixture(
    t,
    (i) =>
      i === 0
        ? { name: "search_web", arguments: { query: "current count" } }
        : i === 1
          ? { name: "web_fetch", arguments: { url: "https://official.example/selector" } }
          : i === 3
            ? { name: "web_fetch", arguments: { url: "https://news.example/live" } }
            : {
                name: "finish_task",
                arguments: {
                  summary:
                    i < 4
                      ? "The selector does not show totals."
                      : "Candidate A has 52%, 12345 votes. https://news.example/live",
                },
              },
    {
      researchReview: (body) => {
        count++;
        return body.includes("12345")
          ? { complete: true, missing: [], nextSteps: [] }
          : {
              complete: false,
              missing: ["Actual count"],
              nextSteps: ["Read alternative result sources"],
            };
      },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  t.mock.method(f.agent.search, "search", async () => ({
    query: "current count",
    status: "ok",
    sources: [
      {
        url: "https://official.example/selector",
        title: "Official results",
        snippet: "Select election",
      },
      { url: "https://news.example/live", title: "Current count", snippet: "Live results" },
    ],
    observedAt: new Date().toISOString(),
    truncated: false,
    provenance: {
      backend: "http",
      provider: "duckduckgo-html",
      searchUrl: "https://example.com/search",
      fullPagesRead: false,
    },
  }));
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.includes("news.example")
      ? "<title>Results</title><main>Candidate A has 52%, 12345 votes.</main>"
      : "<title>Results</title><main>Select election to see results.</main>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "What is the actual count?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.ok(read.mock.calls.some((call) => call.arguments[0] === "https://news.example/live"));
  assert.match(saved.result ?? "", /12345/);
  assert.equal(count, 2);
  assert.ok(
    (await f.agent.journal.operations("owner", task.id)).some(
      (op) => op.toolName === "web_fetch" && op.status === "succeeded" && !op.effect,
    ),
  );
});

test("automatic recovery uses ranked sources, not analytics JSON observed on a page", async () => {
  const { researchRecoverySources } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  const operations = [
    {
      toolName: "search_web",
      args: { query: "count" },
      receipt: {
        sources: [
          { url: "https://news.example/live" },
          { url: "https://alternative.example/live" },
        ],
      },
    },
    {
      toolName: "web_fetch",
      args: { url: "https://news.example/live" },
      receipt: {
        url: "https://news.example/live",
        dataSources: [{ url: "https://analytics.example/config.json" }],
      },
    },
  ] as never;
  assert.deepEqual(researchRecoverySources(operations), ["https://alternative.example/live"]);
});

test("a follow-up recovers from sources observed in the parent conversation when its new searches fail", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      i === 0
        ? { name: "web_fetch", arguments: { url: "https://official.example/selector" } }
        : i === 2
          ? { name: "web_fetch", arguments: { url: "https://news.example/live" } }
          : {
              name: "finish_task",
              arguments: {
                summary:
                  i < 3 ? "No results." : "A: 52%, 12345 votes. Source: https://news.example/live",
              },
            },
    {
      researchReview: (body) =>
        body.includes("12345")
          ? { complete: true, missing: [], nextSteps: [] }
          : {
              complete: false,
              missing: ["Actual count"],
              nextSteps: ["Read a previously observed source"],
            },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.includes("news.example")
      ? "<main>Candidate A: 52%, 12345 votes.</main>"
      : "<main>Select an election to see results.</main>",
  }));
  const task = await f.agent.createTask(
    "owner",
    {
      prompt: "Show the count from that conversation",
    },
    "durable-conversation-admission",
  );
  await f.db.put("owner", "tasks", {
    ...task,
    state: {
      ...task.state,
      conversationContext: {
        messages: [],
        priorResults: [
          {
            taskId: "previous",
            evidence: [
              { kind: "web", url: "https://news.example/live", acquiredAt: "2026-10-04T00:00:00Z" },
              { kind: "file", url: "https://unrelated.example/private-document" },
            ],
          },
        ],
      },
    },
  });
  await f.agent.worker.tick();
  assert.equal((await f.agent.getTask("owner", task.id)).status, "succeeded");
  assert.ok(read.mock.calls.some((call) => call.arguments[0] === "https://news.example/live"));
  assert.ok(!read.mock.calls.some((call) => call.arguments[0].includes("unrelated.example")));
  assert.equal(task.id.length, 64);
  for (const request of fixture.requests) {
    const input = JSON.parse(request.body).input ?? [];
    for (const message of input)
      if (message.call_id)
        assert.ok(
          message.call_id.length <= 64,
          "provider call IDs must fit even with deterministic task IDs",
        );
  }
});

test("verified facts stay available through repeated delivery repair with the full tool catalog", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      i === 0
        ? { name: "web_fetch", arguments: { url: "https://news.example/live" } }
        : {
            name: "finish_task",
            arguments: {
              summary:
                i < 3
                  ? "No results."
                  : i === 3
                    ? "A 52%; B 48%; extra unsupported claim."
                    : "Count:\n- A: 52%\n- B: 48%\nSource: https://news.example/live",
            },
          },
    {
      researchReview: (_body, i) =>
        i < 2
          ? {
              complete: false,
              needsMoreResearch: true,
              missing: ["The count"],
              nextSteps: ["Use observed results"],
            }
          : i === 2
            ? {
                complete: false,
                needsMoreResearch: false,
                missing: ["Unsupported extra claim and readable formatting"],
                nextSteps: ["Remove extra claim and present the observed count in bullets"],
              }
            : { complete: true, needsMoreResearch: false, missing: [], nextSteps: [] },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>A 52%, B 48%</main>",
  }));
  const task = await f.agent.createTask("owner", { prompt: "What is the count?" });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.equal(read.mock.callCount(), 1);
  assert.equal((saved.state.researchDeliveryReview as { attempts: number }).attempts, 4);
  const lastRequest = fixture.requests.at(-1);
  assert.ok(lastRequest);
  const repairTools = offeredHostTools(lastRequest.body);
  assert.ok(repairTools.includes("finish_task"));
  assert.ok(repairTools.includes("read_tool_output"), "previous source results remain retrievable");
  assert.ok(repairTools.includes("todo_list"), "the agent can finish updating its actual plan");
  assert.ok(
    repairTools.includes("web_fetch"),
    "repair retains the ability to acquire additional evidence",
  );
  assert.match(
    lastRequest.body,
    /Remove extra claim and present the observed count in bullets/,
    "the current repair instruction survives context projection",
  );
});

test("artifact delivery repair keeps authoring tools available after the facts are verified", async (t) => {
  let repairOffered = false;
  const fixture = await modelFixture(
    t,
    (i) => {
      if (i === 0) return { name: "web_fetch", arguments: { url: "https://news.example/live" } };
      if (i === 1 || i === 3) {
        if (i === 3) {
          const tools = offeredHostTools(fixture.requests[i].body);
          repairOffered = tools.includes("create_document") || tools.includes("search_tools");
          assert.ok(tools.includes("web_fetch"), "repair does not restrict additional research");
        }
        return {
          name: "create_document",
          arguments: {
            name: "Count",
            format: "text",
            operationId: `draft-${i}`,
            content:
              i === 1
                ? "A: 52%; B: 48%. Source: user."
                : "A: 52%; B: 48%. Source: https://news.example/live",
          },
        };
      }
      return { name: "finish_task", arguments: { summary: "Created the requested count file." } };
    },
    {
      researchReview: (_body, i) =>
        i === 0
          ? {
              complete: false,
              needsMoreResearch: false,
              missing: ["The file incorrectly attributes the observed data to the user"],
              nextSteps: ["Create a corrected file with the observed source attribution"],
            }
          : { complete: true, needsMoreResearch: false, missing: [], nextSteps: [] },
    },
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>A: 52%; B: 48%.</main>",
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Research the count and create a TXT file with the results and source.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  assert.ok(repairOffered);
  assert.equal(read.mock.callCount(), 1);
  const creates = (await f.agent.journal.operations("owner", task.id)).filter(
    (op) => op.toolName === "create_document" && op.status === "succeeded",
  );
  assert.equal(
    creates.length,
    2,
    "the rejected artifact must actually be revised before finishing",
  );
});

test("a revised request restores research tools after an older delivery-only review", async (t) => {
  const fixture = await modelFixture(t, () => undefined, { text: () => "Updated answer." });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "What is the current count?" });
  await f.db.put("owner", "tasks", {
    ...task,
    state: {
      ...task.state,
      desiredRevision: 1,
      appliedRevision: 1,
      researchDeliveryReview: {
        revision: 0,
        complete: false,
        needsMoreResearch: false,
        attempts: 3,
        repairAttempts: 1,
        missing: ["Formatting"],
        nextSteps: ["Use bullets"],
      },
    },
  });
  await f.agent.worker.tick();
  const firstRequest = fixture.requests.at(0);
  assert.ok(firstRequest);
  const tools = offeredHostTools(firstRequest.body);
  assert.ok(tools.includes("web_fetch"), "A new revision must be allowed to acquire new facts");
});

test("review admits escaped source data using the harness token estimate, preserving facts that fit", async (t) => {
  let observed = "";
  await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      observed = JSON.parse(JSON.parse(body).input[0].content[0].text).observations[0].text;
      return { complete: true, missing: [], nextSteps: [] };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Compare A and B in each region." });
  const source = '"\\\n'.repeat(15000) + "Region 27: A 52%, B 48%." + '"\\\n'.repeat(15000);
  const { reviewResearchDelivery } = await import(
    "../apps/server/src/engine/research-delivery-review.ts"
  );
  const decision = await reviewResearchDelivery({
    task,
    summary: "A 52%; B 48%.",
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://news.example/data" },
        receipt: { url: "https://news.example/data", text: source },
      },
    ] as Parameters<typeof reviewResearchDelivery>[0]["operations"],
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    signal: new AbortController().signal,
  });
  assert.equal(decision.complete, true, "a review that fits must actually reach the provider");
  assert.equal(
    observed,
    source,
    "JSON escaping must not invent token pressure or discard the requested facts",
  );
});

test("a review provider outage pauses only the review and resumes without regenerating the image", async (t) => {
  let unavailable = true;
  const calls = [
    { name: "web_fetch", arguments: { url: "https://news.example/results" } },
    {
      name: "generate_image",
      arguments: { prompt: "Geographic map: A 52%, B 48%", operationId: "map" },
    },
    {
      name: "finish_task",
      arguments: { summary: "Geographic map with A 52%, B 48% and source.", outcome: "completed" },
    },
  ];
  const fixture = await modelFixture(t, (i) => calls[i], {
    reviewErrorStatus: () => (unavailable ? 503 : undefined),
    researchReview: () => ({ complete: true, missing: [], nextSteps: [] }),
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  f.agent.config.modelProviders!.routing!.maxAttempts = 1;
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "<main>A 52%, B 48%.</main>",
  }));
  let generations = 0;
  t.mock.method(f.agent.media, "generatedImage", async () => {
    generations++;
    const file = await f.files.importAttachment(
      "owner",
      "map.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
        "base64",
      ),
      "Generated image",
      "image/png",
    );
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt: "Create an infographic with a geographic map showing A and B percentages.",
  });
  await f.agent.worker.tick();
  let saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "waiting_provider",
    "review outages must not become semantic repair instructions or task failures",
  );
  assert.equal(generations, 1);
  assert.equal(saved.completion?.status, undefined);
  assert.equal(
    (await f.agent.detail("owner", task.id)).files.length,
    0,
    "unreviewed images must stay out of the chat delivery",
  );
  const executionRequests = fixture.requests.length;
  unavailable = false;
  const { sharedModelRouter } = await import("../apps/server/src/providers/model-router.ts");
  const cooldown = sharedModelRouter(f.agent.config.modelProviders!).health.get(
    "openai/fixture",
  ).cooldownUntil;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, cooldown - Date.now() + 5)));
  await f.db.put("owner", "tasks", { ...saved, nextRunAt: new Date(0).toISOString() });
  await f.agent.worker.tick();
  saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "succeeded",
    JSON.stringify({
      error: saved.error,
      completion: saved.completion,
      review: saved.state.researchDeliveryReview,
    }),
  );
  assert.equal(generations, 1, "resuming the review must not call the generator again");
  assert.equal(
    fixture.requests.length,
    executionRequests,
    "resume the saved delivery before invoking the executor",
  );
  assert.equal((await f.agent.detail("owner", task.id)).files.length, 1);
});

test("a short follow-up repairs the original geographic map and publishes only the reviewed revision", async (t) => {
  const ids: string[] = [];
  let f: Awaited<ReturnType<typeof taskRuntime>>;
  let taskId = "";
  const calls = [
    { name: "web_fetch", arguments: { url: "https://news.example/results" } },
    {
      name: "generate_image",
      arguments: { prompt: "Grid of region cards, A 52%, B 48%", operationId: "draft" },
    },
    { name: "finish_task", arguments: { summary: "Grid of regions", outcome: "completed" } },
    {
      name: "generate_image",
      arguments: {
        prompt: "Geographic map with real outlines, A 52%, B 48%",
        operationId: "corrected",
      },
    },
  ];
  const fixture = await modelFixture(
    t,
    async (i) => {
      if (i === 3) assert.equal((await f.agent.detail("owner", taskId)).files.length, 0);
      return i === 4
        ? {
            name: "finish_task",
            arguments: {
              summary: "Geographic map with A 52%, B 48%",
              outcome: "completed",
              artifactIds: [ids[1]],
            },
          }
        : calls[i];
    },
    {
      researchReview: (body, index) => {
        const payload = JSON.parse(JSON.parse(body).input[0].content[0].text);
        assert.equal(payload.originalRequest, "faz um novo por gentileza eu apaguei o anterior");
        assert.match(JSON.stringify(payload.conversationContext), /mapa do Brasil/);
        if (index === 1) {
          assert.deepEqual(
            payload.reviewedImageIds,
            [ids[1]],
            "the rejected revision must not be certified as part of the final delivery",
          );
          return { complete: true, missing: [], nextSteps: [], needsMoreResearch: false };
        }
        return {
          complete: false,
          missing: ["The requested geographic map is a grid"],
          nextSteps: ["Replace the grid with real geographic outlines using the observed facts"],
          needsMoreResearch: false,
          requestAudit: [
            {
              requirement: "Geographic map of Brazil",
              satisfied: false,
              evidence: "The image is a grid of cards",
            },
          ],
        };
      },
    },
  );
  f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  const urls: string[] = [];
  t.mock.method(f.agent.web, "document", async (url: string) => {
    urls.push(url);
    return { url, contentType: "text/html", body: "<main>A 52%, B 48%.</main>" };
  });
  t.mock.method(f.agent.media, "generatedImage", async () => {
    const file = await f.files.importAttachment(
      "owner",
      `map-${ids.length}.png`,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
        "base64",
      ),
      "Generated image",
      "image/png",
    );
    ids.push(file.id);
    return f.files.reference("owner", file.id);
  });
  const prompt = "faz um novo por gentileza eu apaguei o anterior";
  const task = await f.agent.createTask(
    "owner",
    { prompt, originThreadId: "map-chat" },
    undefined,
    false,
    undefined,
    prompt,
    [
      {
        id: "original",
        role: "user",
        content:
          "Quero um infográfico: mapa do Brasil mostrando os percentuais de A e B por estado.",
      },
    ],
  );
  taskId = task.id;
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", JSON.stringify(saved.completion));
  assert.deepEqual(
    urls,
    ["https://news.example/results"],
    "a format repair must reuse sufficient observed facts",
  );
  assert.equal(ids.length, 2);
  assert.deepEqual(saved.artifactIds, ids, "both files remain in the task's audit history");
  assert.deepEqual(
    (await f.agent.detail("owner", task.id)).files.map((file) => file.id),
    [ids[1]],
  );
  assert.ok(fixture.requests.length >= 5);
});

test("incomplete image facts are repaired before dispatching an expensive generator", async (t) => {
  const briefDecisions: string[] = [];
  const calls = [
    { name: "web_fetch", arguments: { url: "https://news.example/partial" } },
    {
      name: "generate_image",
      arguments: { prompt: "Map: North A 52%, B 48%; South unknown", operationId: "partial-map" },
    },
    { name: "web_fetch", arguments: { url: "https://news.example/complete" } },
    {
      name: "generate_image",
      arguments: {
        prompt: "Map: North A 52%, B 48%; South A 41%, B 59%",
        operationId: "complete-map",
      },
    },
    {
      name: "finish_task",
      arguments: { summary: "Complete geographic map of both regions and candidates." },
    },
  ];
  await modelFixture(t, (i) => calls[i], {
    imageBriefReview: (body) => {
      const input = JSON.parse(JSON.parse(body).input[0].content[0].text);
      assert.equal(input.stage, "image_brief");
      briefDecisions.push(input.proposedAnswer);
      const complete = input.proposedAnswer.includes("South A 41%");
      return {
        complete,
        needsMoreResearch: !complete,
        missing: complete ? [] : ["South has no values for A and B"],
        nextSteps: complete ? [] : ["Read the observed complete source before generating"],
      };
    },
  });
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: url.endsWith("complete")
      ? "North A 52%, B 48%; South A 41%, B 59%."
      : "North A 52%, B 48%. https://news.example/complete",
  }));
  const generated: string[] = [];
  t.mock.method(
    f.agent.media,
    "generatedImage",
    async (_owner: string, _model: string | undefined, args: unknown) => {
      generated.push((args as { prompt: string }).prompt);
      const file = await f.files.importAttachment(
        "owner",
        "map.png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
          "base64",
        ),
        "Generated image",
        "image/png",
      );
      return f.files.reference("owner", file.id);
    },
  );
  const task = await f.agent.createTask("owner", {
    prompt:
      "Create an infographic with a geographic map of North and South showing A and B percentages.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", JSON.stringify(saved.completion));
  assert.equal(briefDecisions.length, 2);
  assert.deepEqual(generated, [calls[3].arguments.prompt]);
  assert.equal(
    saved.artifactIds.length,
    1,
    "a rejected brief must not create a draft or image receipt",
  );
});

for (const legacyApproved of [false, true])
  test(`an unavailable image brief review resumes the saved generation before another executor inference${legacyApproved ? " from a legacy approved task" : ""}`, async (t) => {
    let unavailable = true;
    let generations = 0;
    const calls = [
      { name: "web_fetch", arguments: { url: "https://news.example/results" } },
      {
        name: "generate_image",
        arguments: { prompt: "Geographic map: A 52%, B 48%", operationId: "map" },
      },
      { name: "finish_task", arguments: { summary: "Geographic map: A 52%, B 48% with source." } },
    ];
    const fixture = await modelFixture(
      t,
      (i) => {
        if (i === 2) {
          assert.equal(
            generations,
            1,
            "the host resumes the approved image before asking the executor",
          );
          assert.ok(
            fixture.requests[i].body.includes('"type":"input_image"'),
            "the resumed executor must see the actual new image, not historical drafts",
          );
        }
        return calls[i];
      },
      {
        imageBriefErrorStatus: () => (unavailable ? 503 : undefined),
      },
    );
    const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
    f.agent.config.modelProviders!.routing!.capabilities["openai/fixture"].vision = true;
    f.agent.config.modelProviders!.routing!.maxAttempts = 1;
    const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
      url,
      contentType: "text/html",
      body: "A 52%, B 48%.",
    }));
    t.mock.method(f.agent.media, "generatedImage", async () => {
      generations++;
      const file = await f.files.importAttachment(
        "owner",
        "map.png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
          "base64",
        ),
        "Generated image",
        "image/png",
      );
      return f.files.reference("owner", file.id);
    });
    const task = await f.agent.createTask("owner", {
      prompt: "Create an infographic with a geographic map showing A and B percentages.",
    });
    await f.agent.worker.tick();
    let saved = await f.agent.getTask("owner", task.id);
    assert.equal(saved.status, "waiting_provider");
    assert.equal(
      generations,
      0,
      "no generator is dispatched while the brief review is unavailable",
    );
    assert.equal(saved.artifactIds.length, 0);
    assert.equal(read.mock.callCount(), 1);
    assert.equal(fixture.requests.length, 2);
    assert.ok(saved.state.pendingImageBrief);
    assert.deepEqual(
      (saved.state.pendingImageGeneration as { args: unknown }).args,
      { ...calls[1].arguments, provider: "auto" },
      "retain the exact image request, not only its prompt",
    );
    unavailable = false;
    if (legacyApproved) {
      const { researchObservations } = await import(
        "../apps/server/src/engine/research-delivery-review.ts"
      );
      const operations = await f.agent.journal.operations("owner", task.id);
      saved.state = {
        ...saved.state,
        pendingImageBrief: null,
        pendingImageGeneration: null,
        researchReviewFailure: null,
        imageBriefReview: {
          key: createHash("sha256")
            .update(
              JSON.stringify({
                prompt: calls[1].arguments.prompt,
                revision: 0,
                observations: researchObservations(operations).map((op) => op.receipt),
              }),
            )
            .digest("hex"),
          revision: 0,
          complete: true,
        },
      };
    }
    const { sharedModelRouter } = await import("../apps/server/src/providers/model-router.ts");
    const cooldown = sharedModelRouter(f.agent.config.modelProviders!).health.get(
      "openai/fixture",
    ).cooldownUntil;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, cooldown - Date.now() + 5)));
    await f.db.put("owner", "tasks", { ...saved, nextRunAt: new Date(0).toISOString() });
    await f.agent.worker.tick();
    saved = await f.agent.getTask("owner", task.id);
    assert.equal(
      saved.status,
      "succeeded",
      JSON.stringify({ error: saved.error, state: saved.state, completion: saved.completion }),
    );
    assert.equal(read.mock.callCount(), 1);
    assert.equal(generations, 1);
    assert.equal(fixture.requests.length, 3, "no inference is needed to resubmit the saved image");
    assert.equal(saved.state.pendingImageGeneration, null);
    assert.equal(
      fixture.imageBriefRequests.length,
      legacyApproved ? 1 : 2,
      "resume the saved brief, then reuse its approval for generation",
    );
    assert.equal((await f.agent.detail("owner", task.id)).files.length, 1);
  });

test("saved evidence recovers complete canonical source data beyond its excerpt without another network read", async (t) => {
  const source =
    "Context. ".repeat(900) + "Verified region Z: A 52%, B 48%." + "Tail. ".repeat(500);
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://news.example/canonical" } },
        { name: "read_task_evidence", arguments: { offset: 0, limit: 1, includeSourceData: true } },
        {
          name: "finish_task",
          arguments: { summary: "Region Z: A 52%, B 48%, from the observed source." },
        },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const read = t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: `<main>${source}</main>`,
  }));
  const task = await f.agent.createTask("owner", {
    prompt: "Compare the two percentages in region Z.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.result);
  const output = JSON.parse(fixture.requests[2].body)
    .input.filter((item: { type: string }) => item.type === "function_call_output")
    .at(-1);
  assert.ok(output, "the evidence read must return a canonical receipt to the model");
  const receipt = JSON.parse(output.output);
  assert.doesNotMatch(receipt.items[0].excerpt, /Verified region Z/);
  assert.match(JSON.stringify(receipt.sourceData), /Verified region Z: A 52%, B 48%/);
  assert.equal(receipt.sourceData[0].url, "https://news.example/canonical");
  assert.equal(read.mock.callCount(), 1, "recovering archived evidence makes no network request");
});

test("a 32k model completes research and image delivery without any larger model fallback", async (t) => {
  const fixture = await modelFixture(
    t,
    (i) =>
      [
        { name: "web_fetch", arguments: { url: "https://news.example/results" } },
        {
          name: "generate_image",
          arguments: {
            prompt: "Geographic map: North A 52%, B 48%; South A 49%, B 51%",
            operationId: "small-model-map",
          },
        },
        {
          name: "finish_task",
          arguments: { summary: "Map with both candidates in both regions and the source." },
        },
      ][i],
  );
  const f = await taskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const providers = f.agent.config.modelProviders;
  assert.ok(providers?.routing);
  providers.routing.capabilities["openai/fixture"] = {
    contextTokens: 32768,
    tools: true,
    structuredOutput: true,
    vision: true,
  };
  f.agent.config.modelFallbacks = [];
  t.mock.method(f.agent.web, "document", async (url: string) => ({
    url,
    contentType: "text/html",
    body: "North A 52%, B 48%; South A 49%, B 51%.",
  }));
  let generations = 0;
  t.mock.method(f.agent.media, "generatedImage", async () => {
    generations++;
    const file = await f.files.importAttachment(
      "owner",
      "map.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=",
        "base64",
      ),
      "Generated image",
      "image/png",
    );
    return f.files.reference("owner", file.id);
  });
  const task = await f.agent.createTask("owner", {
    prompt:
      "Research both candidates' percentages in North and South and generate a geographic infographic.",
  });
  await f.agent.worker.tick();
  const saved = await f.agent.getTask("owner", task.id);
  assert.equal(
    saved.status,
    "succeeded",
    JSON.stringify({ error: saved.error, state: saved.state }),
  );
  assert.equal(generations, 1);
  assert.equal(fixture.requests.length, 3);
  for (const request of [
    ...fixture.requests,
    ...fixture.imageBriefRequests,
    ...fixture.reviewRequests,
  ])
    assert.equal(
      JSON.parse(request.body).model,
      "fixture",
      "every text phase uses the same 32k model",
    );
  assert.equal((await f.agent.detail("owner", task.id)).files.length, 1);
});

test("access review compares visible source quotes and distinguishes unknown descriptive fields from eligibility", async (t) => {
  await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      const instructions = JSON.parse(body).instructions;
      assert.match(instructions, /DESCRIPTIVE_FIELD_SCOPE/);
      assert.match(instructions, /OPEN_CONTENT_ACCESS/);
      return {
        complete: true,
        missing: [],
        nextSteps: [],
        accessAudit: [
          {
            option: "Open course",
            access: "free",
            sourceUrl: "https://courses.example/open",
            quote: "The complete course content is free.",
          },
        ],
      };
    },
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Compare free courses, their language, duration and certificate cost.",
  });
  const common = {
    task,
    summary: "Open course: free content; language and certificate cost not stated by the provider.",
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection" as const,
    proposedDocument: true,
    signal: new AbortController().signal,
  };
  const operations = [
    {
      toolName: "web_fetch",
      status: "succeeded",
      args: { url: "https://courses.example/open" },
      receipt: {
        url: "https://courses.example/open",
        text: "The complete course content is **free**.",
        extraction: { status: "readable" },
      },
    },
  ];
  const decision = await reviewResearchDelivery({ ...common, operations: operations as never });
  assert.equal(decision.complete, true);
  const blocked = await reviewResearchDelivery({
    ...common,
    operations: [
      {
        ...operations[0],
        receipt: {
          ...operations[0].receipt,
          extraction: { status: "partial" },
          error: "Blocked page",
        },
      },
    ] as never,
  });
  assert.equal(blocked.complete, false, "a challenge or partial page cannot certify eligibility");
});

test("free-access proof accepts short exact provider offers and separated verbatim facts without inventing a combined quotation", async (t) => {
  let inspected = false;
  await modelFixture(t, () => undefined, {
    researchReview: (body, i) => {
      inspected = true;
      const instructions = JSON.parse(body).instructions;
      assert.match(instructions, /NAMED_FREE_OFFER/);
      return {
        complete: true,
        missing: [],
        nextSteps: [],
        accessAudit: [
          {
            option: "Course A",
            access: "free",
            sourceUrl: "https://courses.example/a",
            ...(i === 0
              ? { quote: "Free Course" }
              : {
                  quotes: [
                    "90 Days of Access To your Free Course",
                    "4 Hours Of self-paced video lessons",
                  ],
                }),
          },
        ],
      };
    },
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Recommend a free introductory course.",
  });
  const common = {
    task,
    summary: "Course A has free access to the advertised lessons for 90 days.",
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection" as const,
    proposedDocument: true,
    signal: new AbortController().signal,
  };
  const operations = [
    {
      toolName: "web_fetch",
      status: "succeeded",
      args: { url: "https://courses.example/a" },
      receipt: {
        url: "https://courses.example/a",
        text: "Free Course\n4 Hours Of self-paced video lessons\nTopics and syllabus here.\n90 Days of Access To your Free Course",
      },
    },
  ];
  assert.equal(
    (await reviewResearchDelivery({ ...common, operations: operations as never })).complete,
    true,
  );
  assert.equal(
    (await reviewResearchDelivery({ ...common, operations: operations as never })).complete,
    true,
  );
  const missing = await reviewResearchDelivery({
    ...common,
    operations: [
      {
        ...operations[0],
        receipt: {
          ...operations[0].receipt,
          text: "4 Hours Of self-paced video lessons. Subscription required.",
        },
      },
    ] as never,
  });
  assert.equal(missing.complete, false, "all submitted quote fragments must occur in a real read");
  assert.equal(inspected, true);
});

test("free-access proof matches visible linked text without dropping intervening qualifications", async (t) => {
  const fixture = await modelFixture(t, () => undefined, {
    researchReview: () => ({
      complete: true,
      missing: [],
      nextSteps: [],
      accessAudit: [
        {
          option: "Introduction to AI",
          access: "free",
          sourceUrl: "https://courses.example/offer",
          quote: "Our no-cost Introduction to AI course is a great place to start.",
        },
      ],
    }),
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Find a free introductory AI course." });
  const common = {
    task,
    summary: "Introduction to AI: free course access.",
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection" as const,
    signal: new AbortController().signal,
  };
  const review = (text: string) =>
    reviewResearchDelivery({
      ...common,
      operations: [
        {
          toolName: "web_fetch",
          status: "succeeded",
          args: { url: "https://courses.example/offer" },
          receipt: { url: "https://courses.example/offer", text },
        },
      ] as never,
    });
  assert.equal(
    (
      await review(
        "Our no-cost [Introduction to AI](https://courses.example/ai?source=blog) course is a great place to start.",
      )
    ).complete,
    true,
  );
  assert.equal(
    fixture.reviewRequests.length,
    1,
    "visible Markdown link labels need no model protocol retry",
  );
  assert.equal(
    (
      await review(
        "Our no-cost [Introduction to AI](https://courses.example/ai) PREVIEW ONLY course is a great place to start.",
      )
    ).complete,
    false,
  );
  assert.equal(
    (
      await review(
        "Our no-cost [Different course](https://courses.example/Introduction-to-AI) course is a great place to start.",
      )
    ).complete,
    false,
  );
});

test("verbatim source fragments remain evidence when they end inside a Markdown link", async (t) => {
  const fixture = await modelFixture(t, () => undefined, {
    researchReview: () => ({
      complete: true,
      missing: [],
      nextSteps: [],
      accessAudit: [
        {
          option: "Introduction to AI",
          access: "free",
          sourceUrl: "https://courses.example/catalogue",
          quote: "### [Introduction to AI — learn with examples",
          evidence: [
            {
              sourceUrl: "https://courses.example/policy",
              quote: "Every course in our catalogue is free.",
            },
          ],
        },
      ],
    }),
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Find a free introductory AI course." });
  const review = (catalogue: string) =>
    reviewResearchDelivery({
      task,
      summary: "Introduction to AI: free course access.",
      model: "openai/fixture",
      providers: f.agent.config.modelProviders!,
      structured: false,
      stage: "access_selection",
      signal: new AbortController().signal,
      operations: [
        {
          toolName: "web_fetch",
          status: "succeeded",
          args: { url: "https://courses.example/catalogue" },
          receipt: { url: "https://courses.example/catalogue", text: catalogue },
        },
        {
          toolName: "web_fetch",
          status: "succeeded",
          args: { url: "https://courses.example/policy" },
          receipt: {
            url: "https://courses.example/policy",
            text: "Every course in our catalogue is free.",
          },
        },
      ] as never,
    });
  assert.equal(
    (await review("### [Introduction to AI — learn with examples](https://courses.example/ai)"))
      .complete,
    true,
  );
  assert.equal(
    fixture.reviewRequests.length,
    1,
    "an exact source fragment does not need another model call",
  );
  assert.equal(
    (
      await review(
        "### [Introduction to AI — paid lessons; learn with examples](https://courses.example/ai)",
      )
    ).complete,
    false,
  );
  assert.equal(
    (
      await review(
        "### [Different course — learn with examples](https://courses.example/Introduction-to-AI)",
      )
    ).complete,
    false,
  );
});

test("a valid additional access fragment cannot mask a fabricated primary quotation", async (t) => {
  let additional: { quotes?: string[]; evidence?: { sourceUrl: string; quote: string }[] } = {
    quotes: ["45 minutes"],
  };
  await modelFixture(t, () => undefined, {
    researchReview: () => ({
      complete: true,
      missing: [],
      nextSteps: [],
      accessAudit: [
        {
          option: "Open course",
          access: "free",
          sourceUrl: "https://courses.example/free",
          quote: "The complete course is free.",
          ...additional,
        },
      ],
    }),
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Find a free AI course." });
  const common = {
    task,
    summary: "Open course: free access.",
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection" as const,
    signal: new AbortController().signal,
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://courses.example/free" },
        receipt: {
          url: "https://courses.example/free",
          text: "45 minutes. Free registration; paid lessons.",
        },
      },
    ] as never,
  };
  assert.equal((await reviewResearchDelivery(common)).complete, false);
  additional = { evidence: [{ sourceUrl: "https://courses.example/free", quote: "45 minutes" }] };
  assert.equal((await reviewResearchDelivery(common)).complete, false);
});

test("review repairs its own quotation protocol before sending a correct researched draft back to more web searches", async (t) => {
  const fixture = await modelFixture(t, () => undefined, {
    researchReview: (body, i) => {
      if (i === 1) assert.match(JSON.parse(body).instructions, /ACCESS_PROOF_PROTOCOL_REPAIR/);
      return {
        complete: true,
        missing: [],
        nextSteps: [],
        accessAudit: [
          {
            option: "Open course",
            access: "free",
            sourceUrl: "https://courses.example/free",
            quote:
              i === 0 ? "The provider offers all lessons for free." : "Access to your Free Course",
          },
        ],
      };
    },
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Find a free introductory course." });
  const decision = await reviewResearchDelivery({
    task,
    summary: "Open course: free access to its lessons.",
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection",
    proposedDocument: true,
    signal: new AbortController().signal,
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://courses.example/free" },
        receipt: { url: "https://courses.example/free", text: "Access to your Free Course" },
      },
    ] as never,
  });
  assert.equal(decision.complete, true);
  assert.deepEqual(decision.missing, []);
  assert.equal(fixture.reviewRequests.length, 2);
  assert.equal(
    fixture.requests.length,
    0,
    "only the read-only review is corrected; no executor inference or network research is requested",
  );
});

test("free-access proof binds a provider policy and named catalogue entry to their separate observed pages", async (t) => {
  const fixture = await modelFixture(t, () => undefined, {
    researchReview: (body) => {
      const instructions = JSON.parse(body).instructions;
      assert.ok(
        instructions.includes(
          '"sourceUrl":string,"evidence":[{"sourceUrl":string,"quote":string}]',
        ),
        "the actual reviewer output contract must admit page-bound fragments without requiring a redundant primary quotation",
      );
      return {
        complete: true,
        missing: [],
        nextSteps: [],
        accessAudit: [
          {
            option: "Introductory AI",
            access: "free",
            sourceUrl: "https://academy.example/catalogue",
            evidence: [
              {
                sourceUrl: "https://academy.example/policy",
                quote: "Every course in our learning catalogue is free.",
              },
              {
                sourceUrl: "https://academy.example/catalogue",
                quote: "Introductory AI — three hours, all learners.",
              },
            ],
          },
        ],
      };
    },
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", {
    prompt: "Recommend a free introductory course.",
  });
  const observations = [
    {
      toolName: "web_fetch",
      status: "succeeded",
      args: { url: "https://academy.example/policy" },
      receipt: {
        url: "https://academy.example/policy",
        text: "Every course in our learning catalogue is free.",
      },
    },
    {
      toolName: "web_fetch",
      status: "succeeded",
      args: { url: "https://academy.example/catalogue" },
      receipt: {
        url: "https://academy.example/catalogue",
        text: "Introductory AI — three hours, all learners.",
      },
    },
  ];
  const input = {
    task,
    summary: "Introductory AI offers free study through this provider's learning catalogue.",
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection" as const,
    signal: new AbortController().signal,
  };
  const accepted = await reviewResearchDelivery({ ...input, operations: observations as never });
  assert.equal(accepted.complete, true);
  assert.equal(accepted.accessAudit?.[0].evidence?.length, 2);
  assert.equal(fixture.reviewRequests.length, 1, "correct provenance needs no extra inference");
  for (const invalid of [
    observations.slice(1),
    [{ ...observations[0], toolName: "search_web" }, observations[1]],
    [
      {
        ...observations[0],
        receipt: {
          ...observations[0].receipt,
          text: "Registration is free. A subscription is required.",
        },
      },
      observations[1],
    ],
    [
      {
        ...observations[0],
        receipt: { ...observations[0].receipt, error: "Blocked page" },
      },
      observations[1],
    ],
  ])
    assert.equal(
      (await reviewResearchDelivery({ ...input, operations: invalid as never })).complete,
      false,
      "every fragment needs the actual successful page read at its own URL",
    );
});

test("an empty optional proof list is missing evidence, not a provider outage, and does not mask an exact quote", async (t) => {
  await modelFixture(t, () => undefined, {
    researchReview: (_body, i) => ({
      complete: true,
      missing: [],
      nextSteps: [],
      accessAudit: [
        {
          option: "Course A",
          access: "free",
          sourceUrl: "https://courses.example/free",
          quotes: [],
          ...(i === 0 ? { quote: "Free Course" } : {}),
        },
      ],
    }),
  });
  const f = await baseTaskRuntime(t, { agentBackend: "model", model: "openai/fixture" });
  const task = await f.agent.createTask("owner", { prompt: "Find a free course." });
  const input = {
    task,
    summary: "Course A has free lessons.",
    model: "openai/fixture",
    providers: f.agent.config.modelProviders!,
    structured: false,
    stage: "access_selection" as const,
    proposedDocument: true,
    signal: new AbortController().signal,
    operations: [
      {
        toolName: "web_fetch",
        status: "succeeded",
        args: { url: "https://courses.example/free" },
        receipt: { url: "https://courses.example/free", text: "Free Course" },
      },
    ] as never,
  };
  assert.equal((await reviewResearchDelivery(input)).complete, true);
  const missing = await reviewResearchDelivery(input);
  assert.equal(missing.complete, false);
  assert.equal(missing.needsMoreResearch, true);
  assert.match(missing.missing.join(" "), /Course A/);
});
