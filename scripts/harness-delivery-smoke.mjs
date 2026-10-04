// Run inside the candidate server image with its normal provider configuration.
// Uses an isolated temporary database; never reads or mutates production conversations.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

const documentMimes = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Explicit allowlist: never export checkpoint history, tool arguments or image bytes. */
export function smokeProviderDiagnostics(task, scrub) {
  const checkpoint = task?.state?.providerCheckpoint;
  if (!checkpoint || typeof checkpoint !== "object") return undefined;
  const number = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const string = (value) => (typeof value === "string" ? value.slice(0, 240) : undefined);
  const requirements = (value) =>
    value && typeof value === "object"
      ? {
          tools: typeof value.tools === "boolean" ? value.tools : undefined,
          vision: typeof value.vision === "boolean" ? value.vision : undefined,
          structuredOutput:
            typeof value.structuredOutput === "boolean" ? value.structuredOutput : undefined,
          contextTokens: number(value.contextTokens),
        }
      : undefined;
  const admission = checkpoint.admission;
  const messages = Array.isArray(checkpoint.messages) ? checkpoint.messages : [];
  return scrub({
    code: string(checkpoint.code),
    rejectedModel: string(checkpoint.rejectedModel),
    accepted: typeof checkpoint.accepted === "boolean" ? checkpoint.accepted : undefined,
    retryAt: string(checkpoint.retryAt),
    history: {
      messages: messages.length,
      bytes: Buffer.byteLength(JSON.stringify(messages)),
      toolCalls: messages.reduce(
        (count, message) =>
          count + (Array.isArray(message.toolCalls) ? message.toolCalls.length : 0),
        0,
      ),
      toolReceipts: messages.filter((message) => message.role === "tool").length,
    },
    admission:
      admission && typeof admission === "object"
        ? {
            stage: ["context_projection", "provider_dispatch"].includes(admission.stage)
              ? admission.stage
              : undefined,
            requirements: requirements(admission.requirements),
            context:
              admission.context && typeof admission.context === "object"
                ? {
                    baseTokens: number(admission.context.baseTokens),
                    outputReserveTokens: number(admission.context.outputReserveTokens),
                    mandatoryMessages: number(admission.context.mandatoryMessages),
                    mandatoryMessageBytes: number(admission.context.mandatoryMessageBytes),
                    tools: (Array.isArray(admission.context.tools) ? admission.context.tools : [])
                      .slice(0, 256)
                      .map((tool) => ({
                        name: string(tool.name),
                        calls: number(tool.calls),
                        argumentBytes: number(tool.argumentBytes),
                        resultBytes: number(tool.resultBytes),
                      })),
                  }
                : undefined,
            candidates: (Array.isArray(admission.candidates) ? admission.candidates : [])
              .slice(0, 64)
              .map((candidate) => ({
                model: string(candidate.model),
                capabilities: requirements(candidate.capabilities),
                capabilitySource: string(candidate.capabilitySource),
                eligible: typeof candidate.eligible === "boolean" ? candidate.eligible : undefined,
                considered:
                  typeof candidate.considered === "boolean" ? candidate.considered : undefined,
                cooldownUntil: number(candidate.cooldownUntil),
              })),
          }
        : undefined,
  });
}

/** Keep exact diagnostic identifiers; redact before bounding any document prose. */
export function smokeOperationEvidence(operation, scrub) {
  const value = scrub(operation);
  const summary = { tool: value.toolName, status: value.status };
  if (value.toolName === "skills_read") {
    const output = value.receipt;
    return {
      ...summary,
      id: value.id,
      toolCallId: value.toolCallId,
      taskId: value.taskId,
      revision: value.revision,
      args: { id: typeof value.args?.id === "string" ? value.args.id.slice(0, 100) : undefined },
      output:
        output && typeof output === "object"
          ? {
              id: typeof output.id === "string" ? output.id.slice(0, 100) : undefined,
              source: ["builtin", "operator"].includes(output.source) ? output.source : undefined,
              sha256: /^[a-f0-9]{64}$/.test(output.sha256 ?? "") ? output.sha256 : undefined,
              contentSha256:
                typeof output.content === "string" ? sha256(output.content) : undefined,
              contentBytes:
                typeof output.content === "string" ? Buffer.byteLength(output.content) : undefined,
              truncated: typeof output.truncated === "boolean" ? output.truncated : undefined,
              failed: Boolean(output.error),
            }
          : undefined,
    };
  }
  if (
    !/^(?:primitive\.)?(?:design_references|create_document|inspect_document|confirm_document_review|view_file|finish_task)$/.test(
      value.toolName,
    )
  )
    return summary;
  const bounded = (input, key = "") => {
    if (typeof input === "string" && input.length > (key === "content" ? 4000 : 16000))
      return {
        omitted: true,
        journalCharacters: input.length,
        journalSha256: sha256(input),
        excerpt: input.slice(0, 500),
      };
    if (Array.isArray(input)) return input.map((entry) => bounded(entry));
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([name, entry]) => [name, bounded(entry, name)]),
      );
    return input;
  };
  return {
    ...summary,
    id: value.id,
    toolCallId: value.toolCallId,
    taskId: value.taskId,
    revision: value.revision,
    parentOperationId: value.parentOperationId,
    createdAt: value.createdAt,
    dispatchedAt: value.dispatchedAt,
    args: bounded(value.args),
    output: bounded(value.receipt),
    error: bounded(value.receipt?.error ?? value.rejection),
  };
}

const xmlText = (xml) =>
  [...xml.matchAll(/<(?:w|a):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|a):t>/g)]
    .map((match) =>
      match[1].replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
        if (entity.startsWith("&#"))
          return String.fromCodePoint(
            entity[2].toLowerCase() === "x"
              ? Number.parseInt(entity.slice(3, -1), 16)
              : Number(entity.slice(2, -1)),
          );
        return { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[entity];
      }),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

// Native editable content checks supplement the model's rendered-page review.
// Kept import-safe so fixture tests never load credentials or contact a provider.
export async function inspectOfficeExport(bytes, format) {
  if (!["docx", "pptx"].includes(format)) throw new Error("Expected DOCX or PPTX export");
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const types = await zip.file("[Content_Types].xml")?.async("string");
  if (
    !types?.includes(
      format === "docx"
        ? "wordprocessingml.document.main+xml"
        : "presentationml.presentation.main+xml",
    )
  )
    throw new Error("Office package does not declare the requested document format");
  const paths =
    format === "docx"
      ? ["word/document.xml"]
      : Object.keys(zip.files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  if (format === "pptx" && paths.length < 3)
    throw new Error("Guide presentation has fewer than three slides");
  const parts = await Promise.all(
    paths.map(async (path) => {
      const xml = await zip.file(path)?.async("string");
      if (!xml) throw new Error(`Missing Office content part: ${path}`);
      const text = xmlText(xml);
      const native = format === "docx" ? /<w:p(?:\s|>)/.test(xml) : /<p:sp(?:\s|>)/.test(xml);
      if (!native || text.length < 10)
        throw new Error(`Office content is not native editable text: ${path}`);
      return { xml, text };
    }),
  );
  const text = parts.map((part) => part.text).join("\n\n");
  if (text.length < 200) throw new Error("Office guide contains too little readable body text");
  const tables = parts.reduce(
    (total, part) =>
      total +
      (part.xml.match(format === "docx" ? /<w:tbl(?:\s|>)/g : /<a:tbl(?:\s|>)/g) ?? []).length,
    0,
  );
  if (!tables)
    throw new Error("Requested capability comparison is missing its native editable table");
  if (format === "docx" && !/<w:pStyle\b[^>]*w:val="(?:Heading[1-6]|Title)"/i.test(parts[0].xml))
    throw new Error("Word guide has no native heading styles");
  return {
    text,
    textCharacters: text.length,
    nativeEditableText: true,
    nativeTables: tables,
    ...(format === "pptx" && { slides: paths.length }),
  };
}

async function runSmoke() {
  const [
    { createApp },
    { readConfig },
    { configuredSecretScrubber, scrubConfiguredValue },
    { createStore },
    { ConversationAgent },
    { modelProviderConfig },
    { readProtected, writeProtected },
    { LocalThreads },
    { rasterMime },
    { inspectPdf },
    { readPdfText },
    { officeContent },
  ] = await Promise.all([
    import("../dist/apps/server/src/app.js"),
    import("../dist/apps/server/src/config.js"),
    import("../dist/apps/server/src/configured-secrets.js"),
    import("../dist/apps/server/src/db.js"),
    import("../dist/apps/server/src/engine/conversation.js"),
    import("../dist/apps/server/src/providers/config.js"),
    import("../dist/apps/server/src/providers/credential-store.js"),
    import("../dist/apps/server/src/threads.js"),
    import("../dist/packages/domain/src/attachments.js"),
    import("../dist/packages/integrations/src/pdf.js"),
    import("../dist/packages/integrations/src/pdf-text.js"),
    import("../dist/apps/server/src/engine/task-office.js"),
  ]);
  const mode = process.argv[2] ?? "pdf";
  if (!["pdf", "docx", "pptx", "image"].includes(mode))
    throw new Error("Use pdf, docx, pptx or image");
  const designed = mode !== "image";
  const evidence = process.env.HARNESS_EVIDENCE_DIR ?? "/evidence";
  const directory = await mkdtemp(join(tmpdir(), "okami-harness-delivery-"));
  const owner = "isolated-harness-delivery",
    threadId = randomUUID();
  const events = [],
    files = [],
    documentReviews = [],
    reviewPreviews = [],
    blockedRefresh = new Set();
  const secrets = Object.entries(process.env)
    .filter(([name]) => /(?:TOKEN|KEY|SECRET|PASSWORD)/i.test(name))
    .map(([, value]) => value)
    .filter(Boolean);
  const safe = (value) => scrubConfiguredValue(value, configuredSecretScrubber(secrets));
  const deliverable = {
    pdf: "um PDF profissional e visualmente bem diagramado, compacto, com aproximadamente 3 a 5 páginas",
    docx: "um arquivo Word DOCX profissional, compacto, com aproximadamente 3 a 5 páginas e texto, títulos e tabela nativos editáveis",
    pptx: "uma apresentação PowerPoint PPTX profissional com aproximadamente 6 a 8 slides, usando textos, tabelas e formas nativos editáveis",
  };
  const prompt = designed
    ? `Crie ${deliverable[mode]}, em português, explicando como você funciona neste aplicativo: harness, uso de ferramentas, skills instaladas, execução de tarefas e limites reais. Confira seus recursos e skills atuais; não invente capacidades, métricas ou integrações. Inclua uma comparação curta em tabela entre ferramenta, skill e tarefa e uma sequência visual que explique do pedido à entrega. Escolha um estilo coerente com o tema, com hierarquia tipográfica, espaçamento e boa legibilidade; revise visualmente todas as páginas ou slides antes de entregar. Não precisa pesquisar na web: use somente o ambiente atual e identifique o que não consegue verificar. Entregue o arquivo ${mode.toUpperCase()} pronto aqui, sem versões preliminares nem imagens internas da revisão. ${process.env.HARNESS_DOCUMENT_BRIEF ?? ""}`.trim()
    : "Crie um infográfico bonito em português com estes dados definidos: Rotina de estudos, total 60 minutos. Leitura: 20 minutos. Exercícios: 30 minutos. Revisão: 10 minutos. Use os valores exatamente como fornecidos, layout vertical com três blocos e gráfico de divisão do tempo. Me entregue a imagem pronta aqui.";
  let task, cancelChat, db, server, config, failure;
  const upstream = globalThis.fetch;
  const authEndpoints = new Map([
    ["https://auth.openai.com/api/accounts/oauth/token", "chatgpt"],
    ["https://auth.openai.com/oauth/token", "codex"],
  ]);
  // A copied refresh token can still rotate the production grant remotely. Refuse
  // every OAuth refresh before network dispatch, even though only copies are writable.
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const provider = authEndpoints.get(`${url.origin}${url.pathname}`);
    const body = init?.body;
    const refresh =
      body instanceof URLSearchParams
        ? body.get("grant_type") === "refresh_token"
        : typeof body === "string" &&
          new URLSearchParams(body).get("grant_type") === "refresh_token";
    if (provider || refresh) {
      blockedRefresh.add(provider ?? "oauth");
      throw new Error("HARNESS_OAUTH_REFRESH_BLOCKED: fresh production credentials are required");
    }
    return upstream(input, init);
  };
  const timer = setTimeout(() => {
    if (task) server?.agent.worker.abort(task.id);
    cancelChat?.();
  }, 900000);
  await mkdir(evidence, { recursive: true });
  try {
    const original = readConfig();
    const sourceProviders = original.modelProviders ?? modelProviderConfig(original.dataDir);
    const modelProviders = { ...sourceProviders, authDir: join(directory, "credentials") };
    for (const [field, provider] of [
      ["chatgptFile", "chatgpt"],
      ["grokFile", "grok"],
      ["codexFile", "codex"],
    ]) {
      const source = sourceProviders[field];
      modelProviders[field] = join(modelProviders.authDir, `${provider}.json`);
      const credential = source ? await readProtected(source) : undefined;
      if (credential === undefined) continue;
      for (const [key, value] of Object.entries(credential))
        if (/(?:token|secret)/i.test(key) && typeof value === "string") secrets.push(value);
      if (provider === "grok" && typeof credential.token_endpoint === "string") {
        const url = new URL(credential.token_endpoint);
        authEndpoints.set(`${url.origin}${url.pathname}`, provider);
      }
      await writeProtected(modelProviders[field], credential);
    }
    config = {
      ...original,
      dataDir: directory,
      databaseUrl: undefined,
      modelProviders,
      intelligenceApiKey: undefined,
      agentBackend: "model",
      taskWorkerEnabled: false,
      proactivityEnabled: false,
      workerUrl: undefined,
      workerToken: undefined,
      browserFallbackEnabled: false,
      computerEnabled: false,
      computerBackend: "docker",
      computerUrl: undefined,
      computerToken: undefined,
      nativeExecutors: [],
      nativeExecutorId: undefined,
      mcpServers: [],
      push: undefined,
      jevMode: "off",
      googleClientId: undefined,
      googleClientSecret: undefined,
      credentialsOpenBaoAddress: undefined,
      credentialsOpenBaoToken: undefined,
    };
    db = await createStore({ dataDir: join(directory, "postgres") });
    server = await createApp(db, config, {
      credentialSecretStore: {
        async read() {
          return null;
        },
        async write() {
          throw new Error("Credential writes are disabled in isolated smoke");
        },
        async delete() {
          throw new Error("Credential deletes are disabled in isolated smoke");
        },
      },
    });
    if (!(server.threads instanceof LocalThreads))
      throw new Error("Expected isolated local threads");
    await server.threads.ensure(owner, threadId);
    const conversation = new ConversationAgent(config, server.agent, owner);
    await new Promise((resolve, reject) => {
      const subscription = conversation
        .run({
          threadId,
          runId: randomUUID(),
          messages: [{ id: randomUUID(), role: "user", content: prompt }],
          tools: [],
          context: [],
          state: {},
        })
        .subscribe({
          next(event) {
            events.push(event);
            if (event.type === "TOOL_CALL_START")
              console.log(JSON.stringify({ stage: "chat-tool", tool: event.toolCallName }));
          },
          error: reject,
          complete: resolve,
        });
      cancelChat = () => {
        subscription.unsubscribe();
        reject(new Error("Chat deadline exceeded"));
      };
    });
    cancelChat = undefined;
    const tasks = await db.list(owner, "tasks");
    if (tasks.length !== 1)
      throw new Error(`Expected one real delegated task, received ${tasks.length}`);
    task = tasks[0];
    if (task.originThreadId !== threadId) throw new Error("Originating conversation lost");
    for (let attempt = 0; attempt < 6; attempt++) {
      await server.agent.worker.tick();
      task = await server.agent.getTask(owner, task.id);
      console.log(
        JSON.stringify({
          stage: "worker",
          attempt,
          status: task.status,
          artifacts: task.artifactIds.length,
        }),
      );
      if (task.status !== "queued") break;
    }
    for (const id of task.artifactIds) {
      const file = await server.files.get(owner, id),
        bytes = await server.files.bytes(owner, id);
      const extension =
        file.mimeType === "application/pdf"
          ? "pdf"
          : file.mimeType === documentMimes.docx
            ? "docx"
            : file.mimeType === documentMimes.pptx
              ? "pptx"
              : file.mimeType === "image/png"
                ? "png"
                : file.mimeType === "image/jpeg"
                  ? "jpg"
                  : file.mimeType === "image/webp"
                    ? "webp"
                    : "bin";
      await writeFile(join(evidence, `${mode}-${files.length}.${extension}`), bytes);
      let inspection;
      if (file.mimeType === "application/pdf") {
        const metadata = await inspectPdf(bytes);
        const text = await readPdfText(bytes);
        await writeFile(join(evidence, `${mode}-${files.length}.txt`), safe(text));
        inspection = { pages: metadata.pageCount, textCharacters: text.length };
        if (text.trim().length < 200)
          throw new Error("Published PDF guide contains too little readable page text");
      } else if ([documentMimes.docx, documentMimes.pptx].includes(file.mimeType)) {
        const office = await inspectOfficeExport(bytes, extension);
        const verifiedText = officeContent(bytes, file.mimeType);
        if (verifiedText.trim().length < 200)
          throw new Error("Office package body failed independent extraction");
        const { text, ...metadata } = office;
        await writeFile(join(evidence, `${mode}-${files.length}.txt`), safe(verifiedText));
        inspection = { ...metadata, contentExtractionVerified: true };
      } else if (file.mimeType.startsWith("image/")) {
        if (rasterMime(bytes) !== file.mimeType)
          throw new Error("Published image bytes do not match MIME type");
        inspection = { signatureVerified: true };
      }
      files.push({
        id,
        name: file.name,
        mimeType: file.mimeType,
        bytes: bytes.length,
        sha256: sha256(bytes),
        inspection,
      });
      if (designed && file.mimeType === documentMimes[mode]) {
        const revision = Number(task.state.appliedRevision ?? 0),
          scope = `task:${task.id}`;
        const generation = (await db.list(owner, "document-generations")).find(
          (entry) => entry.fileId === id && entry.scope === scope && entry.designVersion === 2,
        );
        if (!generation || generation.sha256 !== sha256(bytes))
          throw new Error("Final document lacks a matching designed-generation receipt");
        const review = await server.agent.media.documentReview.check(
          owner,
          { scope, revision },
          id,
          generation.sha256,
        );
        documentReviews.push({ fileId: id, sha256: generation.sha256, scope, revision, ...review });
        if (!review.passed)
          throw new Error(
            `Final document has unreviewed pages: ${review.missingPages.join(", ") || "no inspection"}`,
          );
        const expectedPages = inspection.pages ?? inspection.slides;
        if (expectedPages !== undefined && review.pageCount !== expectedPages)
          throw new Error("Review coverage differs from exported page/slide count");
      }
    }
  } catch (error) {
    failure = safe({
      name: error?.name,
      code: error?.code,
      message: String(error?.message ?? error),
    });
    process.exitCode = 2;
  } finally {
    clearTimeout(timer);
    if (task && server) task = await server.agent.getTask(owner, task.id).catch(() => task);
    const publication =
      task && db ? await db.get(owner, "thread-publications", `task:${task.id}`) : undefined;
    const history =
      server?.threads instanceof LocalThreads
        ? await server.threads.history(owner, threadId).catch(() => undefined)
        : undefined;
    const detail =
      task && server ? await server.agent.detail(owner, task.id).catch(() => undefined) : undefined;
    const operations = task && server ? await server.agent.journal.operations(owner, task.id) : [];
    const runtimeCalls = new Set(
      events
        .filter(
          (event) => event.type === "TOOL_CALL_START" && event.toolCallName === "read_runtime",
        )
        .map((event) => event.toolCallId),
    );
    const runtimeSourceVerified =
      operations.some(
        (operation) => operation.toolName === "read_runtime" && operation.status === "succeeded",
      ) ||
      events.some((event) => {
        if (event.type !== "TOOL_CALL_RESULT" || !runtimeCalls.has(event.toolCallId)) return false;
        try {
          return JSON.parse(event.content).source === "Current authenticated app runtime";
        } catch {
          return false;
        }
      });
    if (task && server && designed) {
      const collectReviewEvidence = async () => {
        const scope = `task:${task.id}`;
        const inspections = (await db.list(owner, "document-inspections")).filter(
          (entry) => entry.scope === scope,
        );
        const observations = await db.list(owner, "document-image-observations");
        const confirmations = await db.list(owner, "document-reviews");
        const library = await server.files.list(owner);
        for (const inspection of inspections) {
          const preview = await server.files.get(owner, inspection.previewFileId);
          const bytes = await server.files.bytes(owner, preview.id);
          if (rasterMime(bytes) !== "image/png" || sha256(bytes) !== inspection.previewSha256)
            throw new Error("Review preview does not match its rendered-image receipt");
          const evidenceFile = `${mode}-review-${reviewPreviews.length + 1}.png`;
          await writeFile(join(evidence, evidenceFile), bytes);
          const observation = observations.find((entry) => entry.id === inspection.id);
          const confirmation = confirmations.find((entry) => entry.id === inspection.id);
          const observed = Boolean(
            observation &&
              observation.scope === scope &&
              observation.revision === inspection.revision &&
              observation.previewSha256 === inspection.previewSha256,
          );
          const internalOnly =
            preview.internal === true &&
            !task.artifactIds.includes(preview.id) &&
            !detail?.files.some((file) => file.id === preview.id) &&
            !library.some((file) => file.id === preview.id);
          reviewPreviews.push({
            receiptId: inspection.id,
            fileId: inspection.fileId,
            previewFileId: preview.id,
            previewSha256: inspection.previewSha256,
            documentSha256: inspection.sha256,
            scope,
            revision: inspection.revision,
            rendererVersion: inspection.rendererVersion,
            pageCount: inspection.pageCount,
            pages: inspection.pages,
            evidenceFile,
            internalOnly,
            imageObserved: observed,
            observedAt: observation?.observedAt,
            confirmation,
          });
          if (!internalOnly)
            throw new Error(
              "An internal review preview was exposed as a deliverable or library file",
            );
        }
        for (const review of documentReviews) {
          for (const id of review.receiptIds) {
            const preview = reviewPreviews.find((entry) => entry.receiptId === id);
            if (
              !preview?.imageObserved ||
              !preview.confirmation?.passed ||
              preview.confirmation.issues.length ||
              preview.confirmation.scope !== review.scope ||
              preview.confirmation.revision !== review.revision ||
              preview.confirmation.sha256 !== review.sha256 ||
              preview.confirmation.previewSha256 !== preview.previewSha256
            )
              throw new Error(
                "A passed document review lacks matching image-dispatch and confirmation evidence",
              );
          }
        }
        if (task.status === "succeeded" && !runtimeSourceVerified)
          throw new Error("Assistant guide did not verify its actual runtime capabilities");
      };
      await collectReviewEvidence().catch((error) => {
        failure ??= safe({ name: error?.name, message: String(error?.message ?? error) });
        process.exitCode = 2;
      });
    }
    const receipt = safe({
      mode,
      prompt,
      task: task
        ? {
            id: task.id,
            appliedRevision: Number(task.state.appliedRevision ?? 0),
            attempts: task.attempts,
          }
        : undefined,
      status: task?.status ?? "smoke_failed",
      failure,
      blockedCredentialRefresh: [...blockedRefresh],
      ...(blockedRefresh.size
        ? {
            blocker:
              "Fresh provider credentials required; isolated smoke refused to rotate production grants.",
          }
        : {}),
      model: config?.model,
      fallbacks: config?.modelFallbacks,
      error: task?.error,
      question: task?.question,
      providerDiagnostics: smokeProviderDiagnostics(task, safe),
      result: task?.result,
      completion: task?.completion,
      files,
      documentReviews,
      reviewPreviews,
      ...(designed && { runtimeSourceVerified }),
      chatTools: events
        .filter((event) => event.type === "TOOL_CALL_START")
        .map((event) => event.toolCallName),
      chatErrors: events
        .filter((event) => event.type === "RUN_ERROR")
        .map((event) => event.message),
      operations: operations.map((operation) => smokeOperationEvidence(operation, safe)),
      publication: {
        status: publication?.status,
        correctThread: publication?.threadId === threadId,
        messagePresent: Boolean(
          publication &&
            history?.messages.some(
              (message) => message.role === "assistant" && message.content === publication.text,
            ),
        ),
        filesPresent:
          files.length > 0 &&
          files.every((file) => detail?.files.some((item) => item.id === file.id)),
      },
    });
    await writeFile(join(evidence, `${mode}-receipt.json`), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
    if (
      failure ||
      blockedRefresh.size ||
      task?.status !== "succeeded" ||
      !files.some((file) =>
        designed ? file.mimeType === documentMimes[mode] : file.mimeType.startsWith("image/"),
      ) ||
      (designed && (!documentReviews.length || documentReviews.some((review) => !review.passed))) ||
      (designed && files.filter((file) => file.mimeType === documentMimes[mode]).length !== 1) ||
      publication?.status !== "posted" ||
      publication?.threadId !== threadId ||
      !receipt.publication.messagePresent ||
      !receipt.publication.filesPresent
    )
      process.exitCode = 2;
    if (server) {
      await server.codexConnection.close();
      await server.agent.stop();
      await server.threads.close();
      await server.actions.close();
    }
    await db?.close();
    await rm(directory, { recursive: true, force: true });
    globalThis.fetch = upstream;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSmoke();
