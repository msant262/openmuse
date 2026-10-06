import { createHash } from "node:crypto";
import type { AgentArtifact, AgentTask } from "../../../../packages/domain/src/agent.ts";
import { rasterMime } from "../../../../packages/domain/src/attachments.ts";
import type { ActionProposal, Artifact } from "../../../../packages/domain/src/index.ts";
import {
  type CompletionAssessment,
  type CompletionCriterion,
  completionAssessmentSchema,
  completionCriterionSchema,
} from "../../../../packages/domain/src/runtime.ts";
import { inspectPdf } from "../../../../packages/integrations/src/pdf.ts";
import { readPdfText } from "../../../../packages/integrations/src/pdf-text.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { DocumentReview } from "../document-review.ts";
import type { Files } from "../files.ts";
import {
  googleWorkspaceReadObservation,
  googleWorkspaceVerificationBinding,
} from "../google-workspace-tools.ts";
import { readablePage } from "../public-web.ts";
import type { JournalOperation, TaskJournal } from "./task-journal.ts";
import { officeContent } from "./task-office.ts";

/** Literal user content requirements are persisted before any model work.
 * This qualifies bounded explicit lists, without pretending to assess every
 * possible freeform goal semantically. */
function requiredContent(prompt: string): string[] {
  const marker =
    /(?:required\s+(?:sections?|items?|fields?)|(?:se[çc][oõ]es|itens|campos)\s+obrigat[oó]ri[oa]s?|(?:following|these)\s+(?:sections?|items?|fields?))\s*:\s*/i.exec(
      prompt,
    );
  let list: string | undefined;
  if (marker) {
    const [first, ...rest] = prompt.slice(marker.index + marker[0].length).split(/\r?\n/);
    const items = [first];
    for (const line of rest) {
      if (!/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) break;
      items.push(line);
    }
    list = items
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").split(/[.!?](?:\s|$)/)[0])
      .join(",");
  }
  const content = list ?? prompt.match(/\b(?:containing|contendo)\s+(?:the\s+)?([^.!?\n]+)/i)?.[1];
  if (!content) return [];
  return [
    ...new Set(
      content
        .replace(/\s+(?:and|e)\s+(?:send|email|envie|enviar)\b[\s\S]*$/i, "")
        .split(/[,;]|\s+(?:and|e|&)\s+/i)
        .map((item) => item.replace(/^[\s'"`-]+|[\s'"`-]+$/g, "").trim())
        .filter(Boolean),
    ),
  ];
}

export function mandatoryTaskCriteria(
  task: Pick<AgentTask, "kind" | "prompt">,
  proposed?: CompletionCriterion[],
  originalPrompt?: string,
): CompletionCriterion[] {
  const mandatory = taskCriteria({ ...task, prompt: originalPrompt ?? task.prompt });
  // The fallback observation may be qualified by an explicit criterion. File,
  // content and external obligations always remain server-owned requirements.
  const criteria = proposed?.length
    ? mandatory.filter((criterion) => criterion.id !== "observed-result")
    : mandatory;
  const ids = new Set(criteria.map((criterion) => criterion.id));
  for (const criterion of proposed ?? []) {
    let id = criterion.id;
    for (let suffix = 1; ids.has(id); suffix++)
      id = `proposed-${suffix}:${criterion.id.slice(0, 230)}`;
    ids.add(id);
    criteria.push({ ...criterion, id });
  }
  return criteria.map((criterion) => completionCriterionSchema.parse(criterion));
}

function offerResearch(prompt: string) {
  return (
    /(?:buscar|busque|pesquis|find|search|look for|suche|compare|mostre|show)/i.test(prompt) &&
    /(?:promo[çc][oõ]es|ofertas|deals|discounts|angebote)/i.test(prompt)
  );
}
function offerAmounts(text: string): Set<string> {
  const prices = new Set<string>();
  const add = (currency: string, raw: string) => {
    const unit =
      ({ "€": "EUR", "£": "GBP", $: "USD", US$: "USD", R$: "BRL" } as Record<string, string>)[
        currency.toUpperCase()
      ] ?? currency.toUpperCase();
    const decimal = raw.match(/[.,](\d{1,2})$/);
    const digits = raw.replace(/[.,]/g, "");
    const amount = Number(digits) / (decimal ? 10 ** decimal[1].length : 1);
    if (Number.isFinite(amount)) prices.add(`${unit}:${amount}`);
  };
  for (const match of text.matchAll(
    /(€|£|R\$|US\$|\$|EUR|USD|BRL|GBP)\s*(\d+(?:[.,]\d+)*)|(\d+(?:[.,]\d+)*)\s*(€|£|EUR\b|USD\b|BRL\b|GBP\b)/gi,
  )) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 80), match.index);
    if (/(?:frete|entrega|shipping|versand|delivery)[^.!?€£\d]{0,45}$/i.test(prefix)) continue;
    add(match[1] ?? match[4], match[2] ?? match[3]);
  }
  for (const match of text.matchAll(
    /"(?:price|lowPrice|highPrice)"\s*:\s*"?(\d+(?:[.,]\d+)*)"?[^{}]{0,300}"priceCurrency"\s*:\s*"(EUR|USD|BRL|GBP)"/gi,
  ))
    add(match[2], match[1]);
  for (const match of text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
    const discount = Number(match[1].replace(",", "."));
    if (discount > 0 && discount <= 100) prices.add(`DISCOUNT:${discount}`);
  }
  return prices;
}
function deliveredOffer(source: string, report: string) {
  const plainReport = report.replace(/[*_`]/g, "");
  if (
    /(?:não|nao)\s+(?:encontrei|consegui(?:\s+(?:verificar|confirmar|encontrar))?)\s+(?:nenhuma?\s+)?(?:ofertas?|promo[çc][oõ]es)|(?:could not|couldn.t|unable to|did not|didn.t)\s+(?:find|verify|confirm)\s+(?:any\s+|current\s+|verified\s+)*(?:offers?|deals?|promotions?)/i.test(
      plainReport,
    )
  )
    return false;
  const reported = offerAmounts(report);
  return [...offerAmounts(source)].some((price) => reported.has(price));
}

export function taskCriteria(task: Pick<AgentTask, "kind" | "prompt">): CompletionCriterion[] {
  const prompt = task.prompt,
    criteria: CompletionCriterion[] = [],
    content = requiredContent(prompt);
  const remoteGoogleDocument =
    /\b(?:google\s*(?:drive|docs|sheets|slides)|drive|docs|sheets|slides)\b/i.test(prompt) &&
    !/\b(?:download|baixar|baixe|anexo|attachment|pdf|docx|xlsx|pptx|txt|csv)\b/i.test(prompt);
  const mailRequest = /\b(?:gmail|e-?mail)\b/i.test(prompt);
  const explicitSend = [
    ...prompt.matchAll(/\b(?:send|envie|envia|enviar|mande|manda|mandar)\b/gi),
  ].some(
    (match) =>
      !/(?:n[aã]o|not|don't|do not|without|sem|nunca|never)(?:\s+\S+){0,3}\s*$/i.test(
        prompt.slice(Math.max(0, (match.index ?? 0) - 60), match.index),
      ),
  );
  const nativeGmailDraft =
    mailRequest &&
    !explicitSend &&
    /\b(?:draft|rascunho|write|compose|escreve|escreva|escrever|redija|prepare|responde|responda|responder|reply)\b/i.test(
      prompt,
    );
  const format = /\bpdf\b/i.test(prompt)
    ? "application/pdf"
    : /\bdocx\b/i.test(prompt)
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : /\bxlsx\b/i.test(prompt)
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : /\bpptx\b/i.test(prompt)
          ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          : /\btxt\b/i.test(prompt)
            ? "text/plain"
            : undefined;
  if (task.kind === "document")
    criteria.push({
      id: "filled-document",
      kind: "file",
      description:
        format && format !== "application/pdf"
          ? "The requested file exists and opens in its format"
          : "A valid filled PDF copy",
      format: format ?? "application/pdf",
      requiredItems: content,
    });
  else if (
    /\b(infogr[aá]fico|infographic|poster|p[oô]ster|ilustra[çc][aã]o|illustration)\b/i.test(
      prompt,
    ) ||
    (/\b(crie|criar|gere|gerar|create|generate|draw|desenhe|produza)\b/i.test(prompt) &&
      /\b(imagem|image|picture)\b/i.test(prompt))
  )
    criteria.push({
      id: "requested-image",
      kind: "file",
      description: "The requested image was generated and is available as an attachment",
      format: "image/*",
      requiredItems: [],
    });
  else if (
    !remoteGoogleDocument &&
    /\b(pdf|docx|xlsx|pptx|txt|csv|arquivo|file|document|documento)\b/i.test(prompt)
  )
    criteria.push({
      id: "requested-file",
      kind: "file",
      description: "The requested file exists and opens in its format",
      ...(format ? { format } : {}),
      requiredItems: content,
    });
  if (
    (!nativeGmailDraft && content.length > 0) ||
    task.kind === "plan" ||
    task.kind === "finance" ||
    /\b(report|relat[oó]rio|comparison|compara[çc][aã]o|plan|plano)\b/i.test(prompt) ||
    (!nativeGmailDraft &&
      /\b(write|draft|redija|escreva|prepare)\b/i.test(prompt) &&
      /\b(email|e-mail)\b/i.test(prompt))
  )
    if (!criteria.some((criterion) => criterion.kind === "file"))
      criteria.push({
        id: "requested-artifact",
        kind: "artifact",
        description: "The requested structured result exists and contains useful content",
        requiredItems: content,
      });
  if (nativeGmailDraft)
    criteria.push({
      id: "requested-gmail-draft",
      kind: "receipt",
      effect: "email.draft",
      description: "The requested draft was saved in Gmail with a confirmed provider receipt",
      requiredItems: content,
    });
  const send =
    task.kind === "document" ||
    (explicitSend && /\b(email|e-mail|recipient|destinat[aá]rio)\b/i.test(prompt));
  if (send)
    criteria.push({
      id: "requested-send",
      kind: "receipt",
      effect: "email.send",
      description: "The requested email has a confirmed receipt for its recipients",
      requiredItems: [...new Set(prompt.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [])],
    });
  if (
    /\b(calendar|calend[aá]rio|event|evento)\b/i.test(prompt) &&
    /\b(create|crie|schedule|agende|put|prepare|adicione|book|reserve)\b/i.test(prompt)
  )
    criteria.push({
      id: "requested-calendar",
      kind: "receipt",
      effect: "calendar.create",
      description: "The requested calendar event has a confirmed receipt",
      requiredItems: [],
    });
  if (
    /\b(command|comando)\b/i.test(prompt) &&
    /\b(run|execute|executar|rode|rodar)\b/i.test(prompt)
  )
    criteria.push({
      id: "requested-command",
      kind: "receipt",
      effect: "command",
      description: "The requested command has a confirmed successful exit receipt",
      requiredItems: [],
    });
  if (/\b(submit|submeta)\b/i.test(prompt) && /\b(form|formul[aá]rio)\b/i.test(prompt))
    criteria.push({
      id: "requested-browser",
      kind: "receipt",
      effect: "browser",
      description: "The requested form has observed confirmation after its submission",
      requiredItems: [],
    });
  if (
    !criteria.length &&
    /\b(write|draft|compose|create|escreva|escrever|redija|componha|crie|criar)\b/i.test(prompt) &&
    /\b(poem|poema|poetry|poesia|greeting|sauda[çc][aã]o|story|hist[oó]ria|conto|caption|legenda|slogan|texto|text|mensagem|message)\b/i.test(
      prompt,
    )
  )
    criteria.push({
      id: "requested-text",
      kind: "response",
      description: "The requested original text is delivered in the result",
      requiredItems: content,
    });
  if (
    !criteria.length &&
    /\b(book|reserve|purchase|pay|pague|create|crie|schedule|agende|transfer|payment|pagamento|save|salve|salvar|edit|edite|update|atualize)\b/i.test(
      prompt,
    )
  )
    criteria.push({
      id: "requested-receipt",
      kind: "receipt",
      effect: "external",
      description: "The requested external effect has a confirmed receipt",
      requiredItems: [],
    });
  if (offerResearch(prompt))
    criteria.push({
      id: "current-offer",
      kind: "observation",
      description: "A current offer with an observed price or discount from a source page",
      requiredItems: [],
    });
  return criteria.length
    ? criteria
    : [
        {
          id: "observed-result",
          kind: "observation",
          description: "The requested outcome has current observed evidence",
          requiredItems: [],
        },
      ];
}

/** The requested text is the deliverable; a completion claim without steps is not. */
export function textPlanDelivery(task: Pick<AgentTask, "kind" | "prompt">, text: string) {
  if (
    task.kind !== "plan" ||
    !/\b(?:as\s+(?:plain\s+)?text|(?:como|em)\s+texto)\b/i.test(task.prompt)
  )
    return undefined;
  const steps = [...text.matchAll(/^\s*\d+[.)]\s+([^\r\n]+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  return steps.length ? { text, steps } : undefined;
}

function useful(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(useful);
  return Boolean(value && typeof value === "object" && Object.values(value).some(useful));
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function required(criterion: CompletionCriterion, value: unknown) {
  const serialized = JSON.stringify(value).toLowerCase();
  return criterion.requiredItems.every((item) => serialized.includes(item.toLowerCase()));
}
/** Literal labels need content of their own, not another required heading.
 * This is structural evidence, not a semantic assessment of the prose. */
function textContains(content: string, item: string, items: string[]): boolean {
  const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labels = [...new Set(items.map((value) => value.trim().toLowerCase()))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!labels.length) return false;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${labels.map(escapePattern).join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  const matches = [...content.matchAll(pattern)];
  return matches.some((match, index) => {
    if (match[0].toLowerCase() !== item.trim().toLowerCase()) return false;
    const body = content.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index);
    return /[\p{L}\p{N}]/u.test(body);
  });
}
function artifactContains(value: unknown, item: string, items: string[] = [item]): boolean {
  if (typeof value === "string") return textContains(value, item, items);
  if (Array.isArray(value)) return value.some((entry) => artifactContains(entry, item, items));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) =>
    key.trim().toLowerCase() === item.toLowerCase()
      ? useful(entry)
      : artifactContains(entry, item, items),
  );
}
type McpBinding = {
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  signature: string;
  fingerprint: string;
};
function actionMatches(
  criterion: CompletionCriterion,
  action: ActionProposal,
  binding?: McpBinding,
) {
  if (
    action.kind === "external.action" &&
    ["mcp.call", "composio.execute", "google.workspace"].includes(String(action.data.tool)) &&
    !binding
  )
    return false;
  const args = binding?.args ?? action.data;
  if (!useful(action.result) || !required(criterion, { args, result: action.result })) return false;
  if (!criterion.effect) return true;
  if (criterion.effect === "email.draft")
    return (
      action.kind === "external.action" &&
      binding?.serverId === "google-workspace" &&
      /^gmail\.users\.drafts\.(create|update)$/.test(binding.tool)
    );
  if (criterion.effect === "external")
    return [
      "email.send",
      "calendar.create",
      "calendar.update",
      "calendar.delete",
      "external.action",
    ].includes(action.kind);
  if (criterion.effect === "command" || criterion.effect === "browser") return false;
  if (action.kind !== criterion.effect) {
    if (action.kind !== "external.action") return false;
    const tool = binding?.tool ?? "";
    if (
      !(
        criterion.effect === "email.send"
          ? /(?:send.*(?:email|mail)|(?:email|mail).*send)/i
          : criterion.effect === "calendar.update"
            ? /(?:update.*(?:event|calendar)|(?:event|calendar).*update)/i
            : criterion.effect === "calendar.delete"
              ? /(?:delete.*(?:event|calendar)|(?:event|calendar).*delete)/i
              : /(?:create.*(?:event|calendar)|(?:event|calendar).*create)/i
      ).test(tool)
    )
      return false;
  }
  if (criterion.effect === "email.send") {
    const recipients: string[] =
      [args.to, args.recipient, args.recipients, args.recipientEmail]
        .flat(Infinity)
        .filter((value) => typeof value === "string")
        .join(" ")
        .toLowerCase()
        .match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g) ?? [];
    if (
      !criterion.requiredItems
        .filter((item) => item.includes("@"))
        .every((item) => recipients.includes(item.toLowerCase()))
    )
      return false;
  }
  return true;
}
function operationMatches(criterion: CompletionCriterion, op: JournalOperation) {
  if (!op.effect || op.parentOperationId || op.nativeEnvelope || op.status !== "succeeded")
    return false;
  const receipt = object(op.receipt);
  if (
    !receipt ||
    receipt.error ||
    receipt.outcomeUnknown ||
    receipt.skipped ||
    receipt.approvalRequired ||
    !required(criterion, { args: op.args, receipt })
  )
    return false;
  if (!criterion.effect || criterion.effect === "command") {
    if (/^(run_command|run_computer_command)$/.test(op.toolName))
      return (
        typeof receipt.id === "string" &&
        receipt.status === "succeeded" &&
        (receipt.exitCode === undefined || receipt.exitCode === 0)
      );
  }
  if (!criterion.effect || criterion.effect === "browser")
    if (op.toolName === "browser_act")
      return (
        typeof receipt.snapshotId === "string" &&
        typeof receipt.sessionId === "string" &&
        typeof receipt.url === "string" &&
        typeof receipt.text === "string" &&
        /\b(sent|submitted|success|confirmed|receipt|enviado|conclu[ií]do)\b/i.test(receipt.text)
      );
  // Connector writes and email/calendar tools carry a linked ActionProposal;
  // its typed binding and confirmed outcome are checked above.
  return false;
}
export class TaskVerification {
  constructor(
    private readonly db: Store,
    private readonly files: Files,
    private readonly journal: TaskJournal,
  ) {}
  private async mcpBinding(owner: string, action: ActionProposal): Promise<McpBinding | undefined> {
    if (action.kind === "external.action" && action.data.tool === "google.workspace")
      return googleWorkspaceVerificationBinding(this.db, owner, action);
    if (action.kind === "external.action" && action.data.tool === "composio.execute") {
      const saved = await this.db.get<{
        hash: string;
        tool: string;
        binding: {
          taskId: string;
          tool: string;
          args: Record<string, unknown>;
          signature: string;
          discoveryId: string;
        };
      }>(owner, "external-action-bindings", action.id);
      const receipt = await this.db.get<{
        status: string;
        actionHash: string;
        bindingHash: string;
        tool: string;
        result: unknown;
      }>(owner, "composio-receipts", action.id);
      if (
        saved?.tool !== "composio.execute" ||
        saved.hash !== action.hash ||
        saved.binding?.taskId !== action.taskId ||
        !receipt ||
        receipt.status !== "succeeded" ||
        receipt.actionHash !== action.hash ||
        receipt.tool !== saved.binding.tool ||
        receipt.bindingHash !== bindingHash(saved.binding)
      )
        return undefined;
      try {
        if (
          !action.result ||
          bindingHash(receipt.result) !== bindingHash(JSON.parse(action.result))
        )
          return undefined;
      } catch {
        return undefined;
      }
      return {
        serverId: "composio",
        tool: saved.binding.tool,
        args: saved.binding.args,
        signature: saved.binding.signature,
        fingerprint: saved.binding.discoveryId,
      };
    }
    if (action.kind !== "external.action" || action.data.tool !== "mcp.call") return undefined;
    const saved = await this.db.get<{ hash: string; tool: string; binding: McpBinding }>(
      owner,
      "external-action-bindings",
      action.id,
    );
    const receipt = await this.db.get<{
      status: string;
      actionHash: string;
      bindingHash: string;
      serverId: string;
      tool: string;
      result: unknown;
    }>(owner, "mcp-receipts", action.id);
    if (
      saved?.tool !== "mcp.call" ||
      saved.hash !== action.hash ||
      !saved.binding ||
      !receipt ||
      receipt.status !== "succeeded" ||
      receipt.actionHash !== action.hash ||
      receipt.serverId !== saved.binding.serverId ||
      receipt.tool !== saved.binding.tool ||
      receipt.bindingHash !== bindingHash(saved.binding)
    )
      return undefined;
    try {
      if (!action.result || bindingHash(receipt.result) !== bindingHash(JSON.parse(action.result)))
        return undefined;
    } catch {
      return undefined;
    }
    return saved.binding;
  }
  async assess(
    owner: string,
    taskId: string,
    revision: number,
    delivery?: string,
  ): Promise<CompletionAssessment> {
    const task = await this.db.get<AgentTask>(owner, "tasks", taskId);
    if (!task) throw new Error("Task not found");
    const current =
      Number(task.state.desiredRevision ?? 0) === revision &&
      Number(task.state.appliedRevision ?? 0) === revision;
    const artifacts = await this.db.list<AgentArtifact>(owner, "agent-artifacts");
    const receipts = await this.db.list<ActionProposal>(owner, "actions");
    const bindings = new Map(
      await Promise.all(
        receipts
          .filter((action) => action.taskId === taskId && action.status === "succeeded")
          .map(async (action) => [action.id, await this.mcpBinding(owner, action)] as const),
      ),
    );
    const ops = await this.journal.operations(owner, taskId);
    const uncertain = ops.some(
      (op) =>
        op.effect &&
        ["dispatching", "running", "outcome_unknown"].includes(op.status) &&
        op.toolName !== "finish_task",
    );
    const criteria = task.criteria ?? taskCriteria(task);
    const checks = await Promise.all(
      criteria.map(async (criterion) => {
        let evidenceIds: string[] = [];
        if (current && !uncertain) {
          if (criterion.kind === "artifact")
            evidenceIds = artifacts
              .filter(
                (artifact) =>
                  artifact.taskId === taskId &&
                  task.artifactIds.includes(artifact.id) &&
                  (artifact.revision ?? 0) === revision &&
                  (!criterion.referenceId || criterion.referenceId === artifact.id) &&
                  useful(artifact.data) &&
                  criterion.requiredItems.every((item) =>
                    artifactContains(artifact.data, item, criterion.requiredItems),
                  ),
              )
              .map((artifact) => artifact.id);
          else if (criterion.kind === "file")
            for (const id of Array.isArray(task.state.deliveryCandidateArtifactIds)
              ? (task.state.deliveryCandidateArtifactIds as string[])
              : task.artifactIds) {
              if (criterion.referenceId && id !== criterion.referenceId) continue;
              const file = await this.db.get<Artifact>(owner, "files", id);
              if (
                !file ||
                (criterion.format &&
                  (criterion.format === "image/*"
                    ? !file.mimeType.startsWith("image/")
                    : file.mimeType !== criterion.format))
              )
                continue;
              const op = ops.find(
                (entry) =>
                  entry.status === "succeeded" &&
                  entry.revision === revision &&
                  JSON.stringify(entry.receipt).includes(id),
              );
              if (revision > 0 && !op) continue;
              try {
                const bytes = await this.files.bytes(owner, id);
                if (!bytes.length || bytes.length !== file.size) continue;
                let content = "";
                let structuredContent: unknown;
                if (file.mimeType === "application/pdf") {
                  const pdf = await inspectPdf(bytes);
                  if (!pdf.pageCount) continue;
                  // Form values remain valid evidence; normal authored PDFs carry
                  // their content in page drawing streams, not AcroForm fields.
                  structuredContent = {
                    fields: Object.fromEntries(
                      pdf.fields.map((field) => [field.name, field.value]),
                    ),
                    ...(criterion.requiredItems.length
                      ? { pageText: await readPdfText(bytes) }
                      : {}),
                  };
                } else if (/wordprocessingml|presentationml|spreadsheetml/.test(file.mimeType)) {
                  content = officeContent(bytes, file.mimeType);
                } else if (
                  file.mimeType.startsWith("text/") ||
                  file.mimeType === "application/json"
                ) {
                  content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                  if (!content.trim() || content.includes("\0")) continue;
                  if (file.mimeType === "application/json") {
                    structuredContent = JSON.parse(content);
                    if (!useful(structuredContent)) continue;
                  }
                } else if (file.mimeType.startsWith("image/")) {
                  if (rasterMime(bytes) !== file.mimeType) continue;
                } else continue;
                if (
                  criterion.requiredItems.every((item) =>
                    structuredContent !== undefined
                      ? artifactContains(structuredContent, item, criterion.requiredItems)
                      : textContains(content, item, criterion.requiredItems),
                  )
                )
                  evidenceIds.push(id);
              } catch {
                /* Missing, empty and invalid artifacts remain incomplete. */
              }
            }
          else if (criterion.kind === "receipt") {
            evidenceIds = receipts
              .filter(
                (receipt) =>
                  receipt.taskId === taskId &&
                  receipt.status === "succeeded" &&
                  (receipt.dispatchedRevision ?? receipt.preparedRevision ?? 0) === revision &&
                  actionMatches(criterion, receipt, bindings.get(receipt.id)) &&
                  (!criterion.referenceId || criterion.referenceId === receipt.id),
              )
              .map((receipt) => receipt.id);
            evidenceIds.push(
              ...ops
                .filter(
                  (op) =>
                    op.revision === revision &&
                    (!criterion.referenceId || criterion.referenceId === op.id) &&
                    operationMatches(criterion, op),
                )
                .map((op) => op.id),
            );
          } else if (criterion.kind === "response") {
            const text = (delivery ?? task.result ?? "").trim();
            const review = task.state.researchDeliveryReview as
              | { complete?: boolean; revision?: number; deliveryHash?: string }
              | undefined;
            const researchAccepted =
              review?.complete === true &&
              review.revision === revision &&
              review.deliveryHash === createHash("sha256").update(text).digest("hex") &&
              ops.some(
                (op) =>
                  op.revision === revision &&
                  op.status === "succeeded" &&
                  [
                    "web_fetch",
                    "web_extract",
                    "read_web_data",
                    "read_web",
                    "browser_research",
                  ].includes(op.toolName),
              );
            if (
              text.length >= 8 &&
              !/^(done|completed|pronto|feito|conclu[ií]do)[.!\s]*$/i.test(text) &&
              (researchAccepted ||
                criterion.requiredItems.every((item) =>
                  textContains(text, item, criterion.requiredItems),
                ))
            )
              evidenceIds = [`${taskId}:response:${revision}`];
          } else {
            evidenceIds = task.evidence
              .filter(
                (evidence) =>
                  (evidence.revision ?? 0) === revision &&
                  Boolean(evidence.acquiredAt) &&
                  Boolean(evidence.excerpt.trim()) &&
                  !/^Search index:/.test(evidence.title) &&
                  (criterion.id !== "current-offer" ||
                    (evidence.kind === "web" &&
                      deliveredOffer(evidence.excerpt, delivery ?? task.result ?? ""))) &&
                  (!criterion.referenceId || criterion.referenceId === evidence.id) &&
                  criterion.requiredItems.every((item) =>
                    evidence.excerpt.toLowerCase().includes(item.toLowerCase()),
                  ),
              )
              .map((evidence) => evidence.id);
            if (!evidenceIds.length)
              evidenceIds = ops
                .filter((op) => {
                  if (
                    op.revision !== revision ||
                    op.status !== "succeeded" ||
                    !/^(execute_app_tool$|execute_google_workspace_tool$|web_fetch$|read_|skills_read$|computer_status$|browser_(research|navigate|snapshot|screenshot))/.test(
                      op.toolName,
                    ) ||
                    !useful(op.receipt) ||
                    (op.receipt as { error?: unknown })?.error
                  )
                    return false;
                  if (
                    op.toolName === "execute_app_tool" &&
                    (op.receipt as { kind?: string })?.kind !== "composio.read"
                  )
                    return false;
                  if (
                    op.toolName === "execute_google_workspace_tool" &&
                    !googleWorkspaceReadObservation(op.args, op.receipt)
                  )
                    return false;
                  if (
                    criterion.id === "current-offer" &&
                    (!/^(web_fetch|read_web|browser_research|browser_snapshot)$/.test(
                      op.toolName,
                    ) ||
                      !readablePage(op.receipt) ||
                      !deliveredOffer(op.receipt.text, delivery ?? task.result ?? ""))
                  )
                    return false;
                  if (
                    /^(web_fetch|read_web|browser_research|browser_snapshot)$/.test(op.toolName) &&
                    !readablePage(op.receipt)
                  )
                    return false;
                  if (op.toolName === "read_workspace") {
                    const sources = (
                      op.receipt as {
                        sources?: Record<
                          string,
                          { status: string; freshness: string; requiresFreshRead: boolean }
                        >;
                      }
                    )?.sources;
                    return Boolean(
                      sources &&
                        Object.values(sources).length &&
                        Object.values(sources).every(
                          (source) =>
                            ["available", "sample"].includes(source.status) &&
                            source.freshness === "fresh" &&
                            !source.requiresFreshRead,
                        ),
                    );
                  }
                  return criterion.requiredItems.every((item) =>
                    JSON.stringify(op.receipt).toLowerCase().includes(item.toLowerCase()),
                  );
                })
                .map((op) => op.id);
          }
        }
        return { criterionId: criterion.id, passed: evidenceIds.length > 0, evidenceIds };
      }),
    );
    const remaining = criteria
      .filter((_, index) => !checks[index].passed)
      .map((criterion) => criterion.description);
    // Only server-authored designed documents opt into this newer delivery contract.
    // Existing forms, imports and text files retain their established verification.
    const designed = (
      await this.db.list<{ id: string; fileId?: string; sha256?: string; designVersion?: number }>(
        owner,
        "document-generations",
      )
    ).filter(
      (entry) =>
        entry.designVersion === 2 && entry.fileId && task.artifactIds.includes(entry.fileId),
    );
    const documentReview = new DocumentReview(this.db, this.files);
    for (const generated of designed) {
      const fileId = generated.fileId as string;
      let reviewed = false,
        evidenceIds: string[] = [];
      let missingPages: number[] = [];
      try {
        const sha256 = createHash("sha256")
          .update(await this.files.bytes(owner, fileId))
          .digest("hex");
        if (current && !uncertain && sha256 === generated.sha256) {
          const result = await documentReview.check(
            owner,
            { scope: `task:${taskId}`, revision },
            fileId,
            sha256,
          );
          reviewed = result.passed;
          missingPages = result.missingPages;
          evidenceIds = reviewed ? result.receiptIds : [];
        }
      } catch {
        /* Unavailable or changed bytes cannot be visually verified. */
      }
      checks.push({
        criterionId: `document-design-review:${fileId}`,
        passed: reviewed,
        evidenceIds,
      });
      if (!reviewed)
        remaining.push(
          `Render and visually review every page of document ${fileId} with inspect_document and confirm_document_review before delivery${missingPages.length ? `. Pages still requiring a passing review: ${missingPages.join(", ")}` : ""}`,
        );
    }
    if (!current) remaining.push("Apply the latest direction and verify its result");
    if (uncertain) remaining.push("Reconcile the dispatched operation's uncertain result");
    return completionAssessmentSchema.parse({
      status:
        checks.every((check) => check.passed) && !remaining.length
          ? "verified"
          : checks.some((check) => check.passed)
            ? "partial"
            : "unverified",
      checks,
      remaining,
    });
  }
}
