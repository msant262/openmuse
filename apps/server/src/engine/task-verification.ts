import { createHash } from "node:crypto";
import type { AgentArtifact, AgentTask } from "../../../../packages/domain/src/agent.ts";
import { rasterMime } from "../../../../packages/domain/src/attachments.ts";
import {
  browserCdpSchema,
  browserConsoleSchema,
} from "../../../../packages/domain/src/browser-diagnostics.ts";
import { browserImagesSchema } from "../../../../packages/domain/src/browser-images.ts";
import type { ActionProposal, Artifact } from "../../../../packages/domain/src/index.ts";
import {
  type CompletionAssessment,
  type CompletionCriterion,
  completionAssessmentSchema,
  completionCriterionSchema,
} from "../../../../packages/domain/src/runtime.ts";
import { inspectPdf } from "../../../../packages/integrations/src/pdf.ts";
import { readPdfText } from "../../../../packages/integrations/src/pdf-text.ts";
import { workspacePath } from "../computer.ts";
import { commandReceiptSchema, computerSearchReceipt } from "../computer-contract.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { DocumentReview } from "../document-review.ts";
import { driveRemovalEvidence, driveRemovalRequest } from "../drive-removal.ts";
import { nativePythonArgsSchema, pythonResultSchema } from "../executors/python-protocol.ts";
import type { Files } from "../files.ts";
import { verifiedGmailOrganization } from "../gmail-organization.ts";
import { observedDriveSearch } from "../google-drive-search.ts";
import {
  googleWorkspaceReadObservation,
  googleWorkspaceVerificationBinding,
} from "../google-workspace-tools.ts";
import { readablePage } from "../public-web.ts";
import { browserRemovalEvidence, browserRemovalRequest } from "./browser-removal.ts";
import { claimsPendingReview, REVIEWED_ACTION_REPORT } from "./reviewed-action-context.ts";
import type { JournalOperation, TaskJournal } from "./task-journal.ts";
import { officeContent } from "./task-office.ts";

/** Literal user content requirements are persisted before any model work.
 * This qualifies bounded explicit lists, without pretending to assess every
 * possible freeform goal semantically. */
function requiredContent(prompt: string): { items: string[]; literal: boolean } {
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
  const quoted =
    /\b(?:containing|contendo)\s+(?:(?:the\s+)?text\s+|(?:o\s+)?texto\s+)?(?:“([\s\S]*?)”|‘([\s\S]*?)’|(["'`])([\s\S]*?)\3)/i.exec(
      prompt,
    );
  const literal = quoted?.[1] ?? quoted?.[2] ?? quoted?.[4];
  // Quoted text is one literal obligation; punctuation/conjunctions inside it
  // are content, not list separators or the end of the user's instruction.
  if (!list && literal !== undefined) {
    // A literal supplied for creation is the initial state when the person
    // explicitly requests a subsequent replacement. Keeping the old literal
    // as the final obligation makes a correct create/edit/export impossible.
    let finalText = literal;
    const token = "(?:“[^”]*”|‘[^’]*’|\"[^\"]*\"|'[^']*'|\\x60[^\\x60]*\\x60|-?\\d+(?:[.,]\\d+)?)";
    const edits = new RegExp(
      `\\b(?:replace|substitua|troque)\\s+(${token})\\s+(?:with|por)\\s+(${token})`,
      "gi",
    );
    const unquote = (text: string) => (/^[“‘"'`]/.test(text) ? text.slice(1, -1) : text);
    for (const match of prompt.slice(quoted!.index + quoted![0].length).matchAll(edits)) {
      const oldText = unquote(match[1]),
        newText = unquote(match[2]);
      if (oldText && finalText.split(oldText).length === 2)
        finalText = finalText.split(oldText).join(newText);
    }
    return { items: finalText.trim() ? [finalText.trim()] : [], literal: true };
  }
  const content = list ?? prompt.match(/\b(?:containing|contendo)\s+(?:the\s+)?([^.!?\n]+)/i)?.[1];
  if (!content) return { items: [], literal: false };
  return {
    literal: false,
    items: [
      ...new Set(
        content
          .replace(/\s+(?:and|e)\s+(?:send|email|envie|enviar)\b[\s\S]*$/i, "")
          .split(/[,;]|\s+(?:and|e|&)\s+/i)
          .map((item) => item.replace(/^[\s'"`-]+|[\s'"`-]+$/g, "").trim())
          .filter(Boolean),
      ),
    ],
  };
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

/** Explicit execution is an effect obligation, separate from its output file.
 * Explaining or writing source code does not itself request execution. */
function requestedExecution(prompt: string) {
  return [...prompt.matchAll(/\b(?:run|execute|executa|executar|rode|roda|rodar)\b/gi)].some(
    (match) => {
      const index = match.index ?? 0;
      const prefix =
        prompt
          .slice(0, index)
          .split(/[.!?;\n]/)
          .at(-1) ?? "";
      if (
        /(?:n[aã]o|not|don't|do not|without|sem|nunca|never)(?:\s+\S+){0,3}\s*$/i.test(prefix) ||
        /\b(?:como|how\s+to)\s*$/i.test(prefix)
      )
        return false;
      const clause = prompt.slice(index).split(/[.!?;\n]|\b(?:and|e|then|depois)\b/i)[0];
      return /\b(?:command|comando|program|programa|script|code|c[oó]digo)\b/i.test(clause);
    },
  );
}

/** File mentions identify input material too. Require a positive output request
 * before demanding an attachment; a filename lookup can finish with its answer. */
function requestedFileOutput(prompt: string, mailRequest = false) {
  const requests = prompt.matchAll(
    /\b(?:create|generate|produce|build|make|write|draft|export|deliver|download|attach|save|resend|redeliver|crie|cria|criar|gere|gera|gerar|produza|faça|faz|fazer|monte|montar|elabore|elaborar|escreva|escrever|redija|exporte|exportar|entregue|entregar|baixe|baixar|anexe|anexar|salve|salvar|mande|manda|mandar|reenvie|reenviar)\b|\b(?:quero|want|need|preciso)\s+(?:(?:um|uma|a|an|the|o|new|novo|nova)\s+)*(?:pdf|docx|xlsx|pptx|txt|csv|arquivo|file|documento|document|resultado|result|output)\b/gi,
  );
  return [...requests].some((match) => {
    // Writing an email about an existing document creates a Gmail draft, not a
    // new file. Independent create/attach requests still qualify on their own.
    if (
      mailRequest &&
      /^\s+(?:(?:a|an|the|um|uma|o|meu|minha)\s+)*(?:e-?mail|gmail|reply|resposta)\b/i.test(
        prompt.slice((match.index ?? 0) + match[0].length),
      )
    )
      return false;
    const prefix =
      prompt
        .slice(0, match.index)
        .split(/[.!?;\n]/)
        .at(-1) ?? "";
    return !(
      /(?:n[aã]o|not|don't|do not|without|sem|nunca|never)(?:\s+\S+){0,3}\s*$/i.test(prefix) ||
      /\b(?:como|how\s+to)\s*$/i.test(prefix)
    );
  });
}

/** Quoted subject/body fields are literal mail content, not task instructions.
 * Keep other quoted values (filenames, event titles) available for matching. */
function mailInstructionText(prompt: string) {
  if (!/\b(?:gmail|e-?mails?)\b/i.test(prompt)) return prompt;
  return prompt.replace(
    /\b(?:assunto|subject|mensagem|message|corpo|body|texto|text|dizendo|saying|contendo|containing)\s*[:=]?\s*(?:“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`)/gi,
    (field) => field.replace(/(?:“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`)/, " "),
  );
}

export function taskCriteria(task: Pick<AgentTask, "kind" | "prompt">): CompletionCriterion[] {
  // Account selectors and resource URLs are identifiers, not product/action
  // instructions. In particular, gmail.com must not turn an event into mail.
  const prompt = mailInstructionText(task.prompt)
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, " ")
      .replace(/https?:\/\/[^\s<>"'“”‘’]+/gi, " "),
    criteria: CompletionCriterion[] = [],
    content = requiredContent(task.prompt).items;
  const remoteGoogleDocument =
    /\b(?:google\s*(?:drive|docs|sheets|slides)|drive|docs|sheets|slides)\b/i.test(prompt) &&
    !/\b(?:download|baixar|baixe|anexo|attachment|pdf|docx|xlsx|pptx|txt|csv)\b/i.test(prompt);
  const literalFileEdit =
    !remoteGoogleDocument &&
    /\b(?:replace|patch|substitua|substituir|troque|trocar)\b/i.test(prompt) &&
    /\b(?:arquivo|file)\b|[\w-]+\.(?:txt|csv|md|json|ya?ml|toml|ini|ts|tsx|js|jsx|py)\b/i.test(
      prompt,
    );
  const fileDelivery =
    /\b(?:deliver|download|attachment|entregue|entregar|baixe|baixar|anexe|anexo|envie|enviar)\b/i.test(
      prompt,
    );
  const editTarget =
    /\b(?:in|within|no|na|arquivo|file)\s+(?:the\s+)?["'`]?([\p{L}\p{N}_./-]+\.(?:txt|csv|md|json|ya?ml|toml|ini|ts|tsx|js|jsx|py))\b/iu.exec(
      prompt,
    )?.[1];
  const browserRename =
    /\b(?:rename|renomeie|renomear|renomeia)\b/i.test(prompt) &&
    /\b(?:page|p[aá]gina|site|browser|navegador)\b/i.test(prompt) &&
    /https?:\/\//i.test(task.prompt);
  if (browserRename) {
    const match =
      /\b(?:rename|renomeie|renomear|renomeia)\b[\s\S]*?\b(?:to|para)\s+(?:“([^”]+)”|‘([^’]+)’|"([^"]+)"|'([^']+)'|([^\n]+))/i.exec(
        prompt,
      );
    const name = (
      match?.[1] ??
      match?.[2] ??
      match?.[3] ??
      match?.[4] ??
      match?.[5]?.replace(/[:\s]+$/, "")
    )?.trim();
    criteria.push({
      id: "requested-browser-rename",
      kind: "receipt",
      effect: "browser",
      description:
        "Rename the document on the requested page and observe its actual saved name. An unanswered dialog, input argument, page read or promised rename cannot complete the task.",
      requiredItems: name ? (name.match(/[\s\S]{1,300}/g) ?? []) : [],
    });
  }
  if (browserRemovalRequest(task.prompt))
    criteria.push({
      id: "requested-browser-deletion",
      kind: "receipt",
      effect: "browser",
      description:
        "Delete the requested resource on its page with a human-approved, bound browser response and a new explicit deletion confirmation in the resulting page. A visit, read, unanswered or refused dialog, unrelated change or promise cannot complete the task. Inspect the actual result after approval; do not repeat an already dispatched deletion.",
      requiredItems: [],
    });
  if (literalFileEdit)
    criteria.push({
      id: "requested-workspace-edit",
      kind: "receipt",
      effect: "external",
      description:
        "Apply the literal change with patch and confirm the intended file path, changed hashes and replacements. A read, rejected match, unrelated action, or promised change does not complete the edit.",
      requiredItems: editTarget && editTarget.length <= 300 ? [editTarget] : [],
    });
  const driveRemoval = driveRemovalRequest(task.prompt);
  if (driveRemoval)
    criteria.push({
      id: driveRemoval.allMatches
        ? "requested-drive-selection-deletion"
        : "requested-drive-deletion",
      kind: "receipt",
      effect: "drive.delete",
      description:
        "Remove every requested Drive file only after human approval and confirm its state by provider readback. Search metadata or one removal cannot complete a group. Continue from the original selected IDs without repeating confirmed changes.",
      requiredItems: [],
    });
  const mailRequest =
    /\b(?:gmail|e-?mails?)\b/i.test(prompt) ||
    /caixa(?:s)?\s+(?:de\s+)?(?:entrada|principal|separada)|inbox/i.test(prompt);
  const deleteMail =
    mailRequest &&
    /\b(?:delete|remove|trash|apague|apaga|apagar|exclua|excluir|exclui|deleta|deletar|lixeira)\b/i.test(
      prompt,
    ) &&
    !/\b(?:draft|rascunho)\b/i.test(prompt);
  if (deleteMail)
    criteria.push({
      id: /\b(?:all|every|todos|todas)\b/i.test(prompt)
        ? "requested-mail-selection-deletion"
        : "requested-mail-deletion",
      kind: "receipt",
      effect: "email.delete",
      description:
        "Use prepare_gmail_trash(account,query,operationId) for deleting a group of emails: the server selects every search page and prepares one approval card. Only after human approval and provider readback can the entire requested selection be completed. Never prepare just one message from search_mail when the person requested all matches.",
      requiredItems: [],
    });
  const organizeMail =
    mailRequest &&
    !deleteMail &&
    /(?:\borganiz|\blimp|\barquiv(?:ar|a|e|em)\b|\b(?:archive|clean|move|mova|mover)\b|\bsepar|\brotul(?:a|e|ar)|\betiquet(?:a|e|ar)|\bapli(?:ca|que|car)[\s\S]*(?:marcador|r[oó]tulo|label)|\blabel\s+(?:the|these|my)|\bcoloca.*caixa)/i.test(
      prompt,
    );
  if (organizeMail)
    criteria.push({
      id: "requested-mail-organization",
      kind: "receipt",
      effect: "email.organize",
      description:
        "Organize Gmail with organize_gmail: finish all frozen search pages, apply the requested labels/archive, and confirm every message by provider readback. Creating a label or reading mail alone does not fulfill this request.",
      requiredItems: [],
    });
  const explicitSend = [
    ...prompt.matchAll(/\b(?:send|envie|envia|enviar|mande|manda|mandar)\b/gi),
  ].some((match) => {
    const prefix =
      prompt
        .slice(Math.max(0, (match.index ?? 0) - 100), match.index)
        .split(/[.!?;\n]/)
        .at(-1) ?? "";
    return !(
      /(?:n[aã]o|not|don't|do not|without|sem|nunca|never)(?:\s+\S+){0,3}\s*$/i.test(prefix) ||
      /\b(?:acabei|acabamos|acabou|acabaram)\s+de\s*$|\b(?:was|were)\s+(?:told|asked)\s+to\s*$/i.test(
        prefix,
      )
    );
  });
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
    (!literalFileEdit || fileDelivery) &&
    requestedFileOutput(prompt, mailRequest) &&
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
    ((!browserRename || requestedFileOutput(prompt, mailRequest)) &&
      /\b(report|relat[oó]rio|comparison|compara[çc][aã]o|plan|plano)\b/i.test(
        prompt.replace(/“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`/g, " "),
      )) ||
    (!nativeGmailDraft &&
      /\b(write|draft|redija|escreva|prepare)\b/i.test(prompt) &&
      /\b(email|e-mail)\b/i.test(prompt))
  )
    if (!remoteGoogleDocument && !criteria.some((criterion) => criterion.kind === "file"))
      criteria.push({
        id: "requested-artifact",
        kind: "artifact",
        description: "The requested structured result exists and contains useful content",
        requiredItems: content,
      });
  if (
    remoteGoogleDocument &&
    /\b(create|crie|cria|criar|write|escreva|escrever|update|atualize|atualizar|salve|salvar)\b/i.test(
      prompt,
    ) &&
    !criteria.length
  )
    criteria.push({
      id: "requested-google-document",
      kind: "receipt",
      effect: "external",
      description: "The requested cloud document operation has a confirmed native Google receipt",
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
      requiredItems: [...new Set(task.prompt.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [])],
    });
  if (
    (/\b(calendar|calend[aá]rio|event|evento)\b/i.test(prompt) ||
      (/\bagenda\b/i.test(prompt) &&
        /\b(coloca|coloque|agende|agendar|marque|marca|marcar|schedule|book|reserve)\b/i.test(
          prompt,
        ))) &&
    /\b(create|crie|cria|criar|schedule|agende|agendar|put|prepare|adicione|adiciona|adicionar|coloca|coloque|marque|marca|marcar|book|reserve)\b/i.test(
      prompt,
    )
  )
    criteria.push({
      id: "requested-calendar",
      kind: "receipt",
      effect: "calendar.create",
      description: "The requested calendar event has a confirmed receipt",
      requiredItems: [],
    });
  const deleteCalendar = [
    ...prompt.matchAll(
      /\b(?:delete|remove|apague|apaga|apagar|exclua|excluir|exclui|deleta|deletar|remova|remover)\b/gi,
    ),
  ].some((match) => {
    const clause = prompt.slice((match.index ?? 0) + match[0].length).split(/[.!?;\n]/)[0];
    const target =
      /\b(?:e-?mails?|mensagens?|messages?|arquivos?|files?|documentos?|documents?|eventos?|events?|compromissos?|appointments?)\b/i.exec(
        clause,
      );
    return Boolean(target && /^(?:event|evento|compromisso|appointment)/i.test(target[0]));
  });
  if (deleteCalendar)
    criteria.push({
      id: "requested-calendar-deletion",
      kind: "receipt",
      effect: "calendar.delete",
      description:
        "Delete the requested calendar event only after human approval and obtain its confirmed provider receipt. Finding the event or preparing an approval alone does not complete deletion.",
      requiredItems: [],
    });
  if (requestedExecution(prompt))
    criteria.push({
      id: "requested-command",
      kind: "receipt",
      effect: "command",
      description:
        "Execute the requested command/program and obtain its successful runtime receipt. Writing the expected output or source file alone does not prove execution.",
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
  if (
    /\b(?:vers[aã]o\s+(?:do|desse|deste|de)\s+navegador|browser\s+version|version\s+of\s+(?:the|my|your)\s+browser)\b/i.test(
      prompt,
    ) &&
    /\b(?:computador|agente|usado|installed|computer|my|your)\b/i.test(prompt)
  )
    criteria.push({
      id: "requested-browser-version",
      kind: "observation",
      description:
        "Report the exact installed browser version from a current Browser.getVersion receipt. A title or console read does not establish the version.",
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
function textContains(content: string, item: string, items: string[], literal = false): boolean {
  if (literal) return content.includes(item);
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
function artifactContains(
  value: unknown,
  item: string,
  items: string[] = [item],
  literal = false,
): boolean {
  if (typeof value === "string") return textContains(value, item, items, literal);
  if (Array.isArray(value))
    return value.some((entry) => artifactContains(entry, item, items, literal));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) =>
    key.trim().toLowerCase() === item.toLowerCase()
      ? useful(entry)
      : artifactContains(entry, item, items, literal),
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
  if (criterion.id === "requested-workspace-edit") return false;
  if (
    action.kind === "external.action" &&
    ["mcp.call", "composio.execute", "google.workspace"].includes(String(action.data.tool)) &&
    !binding
  )
    return false;
  const args = binding?.args ?? action.data;
  if (criterion.id === "requested-google-document" && binding?.serverId !== "google-workspace")
    return false;
  if (!useful(action.result) || !required(criterion, { args, result: action.result })) return false;
  if (!criterion.effect) return true;
  if (criterion.effect === "email.delete") {
    if (binding?.serverId !== "google-workspace") return false;
    const receipt = object(
      typeof action.result === "string" ? JSON.parse(action.result) : action.result,
    );
    const change = object(receipt?.mailChange);
    const selection = object(receipt?.mailSelection);
    return (
      binding?.serverId === "google-workspace" &&
      change?.verified === true &&
      (Number(change.trashed) > 0 || Number(change.deleted) > 0) &&
      (criterion.id !== "requested-mail-selection-deletion" ||
        (selection?.complete === true && Number(selection.matched) === Number(change.processed)))
    );
  }
  if (criterion.effect === "email.organize") return false;
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
/** A script's own return value cannot establish execution. Match the complete
 * result to its canonical native cell and original host-call lineage. */
function observedNativePython(op: JournalOperation, operations: JournalOperation[]) {
  const args = object(op.args),
    receipt = object(op.receipt),
    command = object(receipt?.command);
  if (
    op.toolName !== "execute_code" ||
    op.parentOperationId ||
    op.status !== "succeeded" ||
    args?.language !== "python" ||
    typeof args.code !== "string" ||
    command?.status !== "succeeded"
  )
    return false;
  const result = pythonResultSchema.safeParse(receipt?.result);
  if (
    !result.success ||
    result.data.status !== "ok" ||
    result.data.state_lost ||
    result.data.host_call_pending ||
    result.data.error
  )
    return false;
  const native = operations.find((child) => child.id === command.id);
  if (
    native?.status !== "succeeded" ||
    native.taskId !== op.taskId ||
    native.revision !== op.revision ||
    native.toolName !== "native.command" ||
    native.nativeEnvelope?.capability !== "python" ||
    native.nativeEnvelope.kind !== "command" ||
    native.nativeEnvelope.inspection === true
  )
    return false;
  const parent = operations.find((entry) => entry.id === native.parentOperationId);
  if (
    parent?.id !== op.id &&
    !(
      parent?.parentOperationId === op.id &&
      parent.toolName === "primitive.execute_code" &&
      parent.status === "succeeded"
    )
  )
    return false;
  const cell = nativePythonArgsSchema.safeParse(native.args);
  const delivered = object(native.receipt),
    data = object(delivered?.data);
  const nativeResult = pythonResultSchema.safeParse(data?.result);
  return (
    cell.success &&
    cell.data.pythonCell.code === args.code &&
    delivered?.status === "succeeded" &&
    data?.cellSettled === true &&
    data.stateLost === false &&
    data.hostCallPending === false &&
    nativeResult.success &&
    bindingHash(result.data) === bindingHash(nativeResult.data)
  );
}

function operationMatches(
  criterion: CompletionCriterion,
  op: JournalOperation,
  prompt: string,
  operations: JournalOperation[] = [],
) {
  if (criterion.id === "requested-browser-deletion") return false;
  const codeMode = criterion.effect === "command" && op.toolName === "execute_code";
  if (
    (!op.effect && !codeMode) ||
    op.parentOperationId ||
    op.nativeEnvelope ||
    op.status !== "succeeded"
  )
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
  if (codeMode && object(op.args)?.language === "python")
    return /\bpython\w*\b/i.test(prompt) && observedNativePython(op, operations);
  if (codeMode)
    return (
      !/\b(?:python\w*|bash|shell|terminal|comando|command|powershell|ruby|php|java|rust|gcc)\b/i.test(
        prompt,
      ) &&
      typeof object(op.args)?.code === "string" &&
      Boolean(String(object(op.args)?.code).trim()) &&
      receipt.status === "completed"
    );
  if (criterion.id === "requested-workspace-edit") {
    const requestedPath = object(op.args)?.path;
    if (typeof requestedPath !== "string") return false;
    let path: string;
    try {
      path = workspacePath(
        requestedPath.startsWith("/") ? requestedPath : `/workspace/${requestedPath}`,
      );
    } catch {
      return false;
    }
    return (
      op.toolName === "patch" &&
      receipt.status === "succeeded" &&
      receipt.path === path &&
      criterion.requiredItems.every((target) =>
        target.includes("/")
          ? path === (target.startsWith("/") ? target : `/workspace/${target}`)
          : path.split("/").at(-1) === target,
      ) &&
      typeof receipt.beforeSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(receipt.beforeSha256) &&
      typeof receipt.afterSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(receipt.afterSha256) &&
      receipt.beforeSha256 !== receipt.afterSha256 &&
      Number.isSafeInteger(receipt.replacements) &&
      Number(receipt.replacements) > 0
    );
  }
  if (!criterion.effect || criterion.effect === "command") {
    if (/^(run_command|run_computer_command)$/.test(op.toolName))
      return (
        typeof receipt.id === "string" &&
        receipt.status === "succeeded" &&
        (receipt.exitCode === undefined || receipt.exitCode === 0)
      );
  }
  if (!criterion.effect || criterion.effect === "browser")
    if (op.toolName === "browser_act" || op.toolName === "browser_dialog")
      return (
        !receipt.dialog &&
        (op.toolName !== "browser_dialog" ||
          (object(receipt.response)?.accept === true &&
            object(receipt.response)?.dialogId === object(op.args)?.dialogId)) &&
        typeof receipt.snapshotId === "string" &&
        typeof receipt.sessionId === "string" &&
        typeof receipt.url === "string" &&
        typeof receipt.text === "string" &&
        (criterion.id === "requested-browser-rename"
          ? criterion.requiredItems.length > 0 &&
            criterion.requiredItems.every((item) => String(receipt.text).includes(item)) &&
            (op.toolName === "browser_dialog" || object(object(op.args)?.act)?.action === "click")
          : /\b(sent|submitted|success|confirmed|receipt|enviado|conclu[ií]do)\b/i.test(
              receipt.text,
            ))
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
    const pendingDialogs = new Map<
      string,
      { sessionId: string; operation: { sequence?: number; createdAt: string } }
    >();
    const answeredDialogs = new Set<string>();
    for (const action of receipts) {
      if (
        action.taskId !== taskId ||
        action.status !== "succeeded" ||
        action.dispatchedRevision !== revision ||
        !["browser.act", "browser.dialog"].includes(String(action.data?.tool))
      )
        continue;
      try {
        const receipt = object(JSON.parse(action.result ?? ""));
        const dialogId = object(receipt?.dialog)?.id;
        if (
          typeof receipt?.sessionId === "string" &&
          typeof receipt.snapshotId === "string" &&
          typeof dialogId === "string"
        )
          pendingDialogs.set(dialogId, {
            sessionId: receipt.sessionId,
            operation: { createdAt: action.createdAt },
          });
      } catch {
        /* Legacy receipts do not contain browser observations. */
      }
    }
    for (const op of ops) {
      if (
        op.status !== "succeeded" ||
        op.revision !== revision ||
        !op.toolName.startsWith("browser_")
      )
        continue;
      const receipt = object(op.receipt);
      if (typeof receipt?.sessionId !== "string" || typeof receipt.snapshotId !== "string")
        continue;
      const dialogId = object(receipt.dialog)?.id;
      if (typeof dialogId === "string")
        pendingDialogs.set(dialogId, { sessionId: receipt.sessionId, operation: op });
      const answered = object(receipt.response)?.dialogId;
      if (
        op.toolName === "browser_dialog" &&
        typeof answered === "string" &&
        answered === object(op.args)?.dialogId
      )
        answeredDialogs.add(answered);
    }
    for (const op of ops) {
      const receipt = object(op.receipt);
      if (
        op.status !== "succeeded" ||
        op.revision !== revision ||
        op.toolName !== "browser_snapshot" ||
        receipt?.dialog ||
        typeof receipt?.snapshotId !== "string"
      )
        continue;
      for (const [id, pending] of pendingDialogs) {
        const newer =
          op.sequence !== undefined && pending.operation.sequence !== undefined
            ? op.sequence > pending.operation.sequence
            : Date.parse(op.createdAt) > Date.parse(pending.operation.createdAt);
        if (newer && receipt.sessionId === pending.sessionId) answeredDialogs.add(id);
      }
    }
    for (const action of receipts) {
      if (
        action.taskId !== taskId ||
        action.status !== "succeeded" ||
        action.data?.tool !== "browser.dialog"
      )
        continue;
      let receipt: Record<string, unknown> | undefined;
      try {
        receipt = object(JSON.parse(action.result ?? ""));
      } catch {
        continue;
      }
      const sessionId = receipt?.sessionId,
        answered = object(receipt?.response)?.dialogId;
      const pending = typeof answered === "string" ? pendingDialogs.get(answered) : undefined;
      if (
        typeof sessionId !== "string" ||
        typeof answered !== "string" ||
        !pending ||
        pending.sessionId !== sessionId
      )
        continue;
      answeredDialogs.add(answered);
      const next = object(receipt?.dialog)?.id;
      if (typeof next === "string")
        pendingDialogs.set(next, { sessionId, operation: pending.operation });
    }
    for (const answered of answeredDialogs) pendingDialogs.delete(answered);
    const uncertain = ops.some(
      (op) =>
        op.effect &&
        ["dispatching", "running", "outcome_unknown"].includes(op.status) &&
        op.toolName !== "finish_task",
    );
    const criteria = task.criteria ?? taskCriteria(task);
    const requestedContent = requiredContent(task.prompt);
    const driveMissing: string[] = [];
    const checks = await Promise.all(
      criteria.map(async (criterion) => {
        const literal =
          requestedContent.literal &&
          criterion.requiredItems.every((item) => requestedContent.items.includes(item));
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
                    artifactContains(artifact.data, item, criterion.requiredItems, literal),
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
                const edit = criteria.find((entry) => entry.id === "requested-workspace-edit");
                if (edit) {
                  const editedHashes = new Map(
                    ops
                      .filter(
                        (entry) =>
                          entry.revision === revision && operationMatches(edit, entry, task.prompt),
                      )
                      .map((entry) => {
                        const receipt = object(entry.receipt)!;
                        return [receipt.path, receipt.afterSha256] as const;
                      }),
                  );
                  const exported = ops.some((entry) => {
                    if (
                      entry.status !== "succeeded" ||
                      entry.revision !== revision ||
                      !/^(?:primitive\.)?export_computer_file$/.test(entry.toolName) ||
                      object(entry.receipt)?.fileId !== id
                    )
                      return false;
                    const path = object(entry.args)?.path;
                    if (typeof path !== "string") return false;
                    try {
                      const canonical = workspacePath(
                        path.startsWith("/") ? path : `/workspace/${path}`,
                      );
                      return (
                        editedHashes.get(canonical) ===
                        createHash("sha256").update(bytes).digest("hex")
                      );
                    } catch {
                      return false;
                    }
                  });
                  if (!exported) continue;
                }
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
                      ? artifactContains(structuredContent, item, criterion.requiredItems, literal)
                      : textContains(content, item, criterion.requiredItems, literal),
                  )
                )
                  evidenceIds.push(id);
              } catch {
                /* Missing, empty and invalid artifacts remain incomplete. */
              }
            }
          else if (criterion.kind === "receipt") {
            if (criterion.effect === "drive.delete") {
              const removal = driveRemovalEvidence(
                task.prompt,
                ops.filter((op) => op.revision === revision),
                receipts.filter(
                  (action) =>
                    action.taskId === taskId &&
                    (action.dispatchedRevision ?? action.preparedRevision ?? 0) === revision,
                ),
                bindings,
              );
              evidenceIds = removal.complete ? removal.evidenceIds : [];
              if (!removal.complete) driveMissing.push(...removal.missing);
            } else if (criterion.id === "requested-browser-deletion")
              evidenceIds = await browserRemovalEvidence(
                this.db,
                owner,
                taskId,
                revision,
                task.prompt,
                ops,
                receipts,
              );
            else if (criterion.effect === "email.organize")
              evidenceIds = await verifiedGmailOrganization(this.db, owner, taskId, revision);
            else
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
            if (criterion.effect === "email.delete") {
              const empty = await this.db.list<{
                id: string;
                taskId?: string;
                revision: number;
                selection: { ids: string[] };
              }>(owner, "gmail-trash-intents");
              evidenceIds.push(
                ...empty
                  .filter(
                    (p) =>
                      p.taskId === taskId &&
                      p.revision === revision &&
                      p.selection.ids.length === 0,
                  )
                  .map((p) => p.id),
              );
            }
            evidenceIds.push(
              ...ops
                .filter(
                  (op) =>
                    op.revision === revision &&
                    (!criterion.referenceId || criterion.referenceId === op.id) &&
                    operationMatches(criterion, op, task.prompt, ops),
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
                  criterion.id !== "requested-browser-version" &&
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
                    !/^(execute_code$|execute_app_tool$|execute_google_workspace_tool$|search_mail$|search_drive$|search_files$|run_computer_command$|web_fetch$|read_|skills_read$|computer_status$|browser_(research|navigate|snapshot|screenshot|get_images|console|cdp)$)/.test(
                      op.toolName,
                    ) ||
                    !useful(op.receipt) ||
                    (op.receipt as { error?: unknown })?.error
                  )
                    return false;
                  if (op.toolName === "execute_code" && !observedNativePython(op, ops))
                    return false;
                  if (op.toolName === "search_mail") {
                    const result = op.receipt as { account?: unknown; matches?: unknown };
                    if (typeof result.account !== "string" || !Array.isArray(result.matches))
                      return false;
                  }
                  if (op.toolName === "search_drive" && !observedDriveSearch(op.receipt))
                    return false;
                  if (op.toolName === "search_files") {
                    const search = computerSearchReceipt.safeParse(op.receipt);
                    if (
                      !search.success ||
                      (!search.data.results.length &&
                        (!search.data.complete || search.data.totalMatches !== 0))
                    )
                      return false;
                  }
                  if (op.toolName === "browser_get_images") {
                    const images = browserImagesSchema.safeParse(op.receipt);
                    if (!images.success || images.data.partial) return false;
                  }
                  if (op.toolName === "browser_console") {
                    const console = browserConsoleSchema.safeParse(op.receipt);
                    if (!console.success || console.data.dropped > 0) return false;
                  }
                  if (op.toolName === "browser_cdp") {
                    const protocol = browserCdpSchema.safeParse(op.receipt);
                    const command = (op.args as { command?: { method?: string } }).command;
                    if (!protocol.success || protocol.data.method !== command?.method) return false;
                  }
                  if (criterion.id === "requested-browser-version") {
                    const protocol = browserCdpSchema.safeParse(op.receipt);
                    if (
                      op.toolName !== "browser_cdp" ||
                      !protocol.success ||
                      protocol.data.method !== "Browser.getVersion"
                    )
                      return false;
                    const product = protocol.data.result.product;
                    if (
                      typeof product !== "string" ||
                      !/^\S+\/\d+(?:\.\d+)*$/.test(product) ||
                      !(delivery ?? task.result ?? "").includes(product.split("/")[1])
                    )
                      return false;
                  }
                  if (op.toolName === "run_computer_command") {
                    const command = commandReceiptSchema.safeParse(op.receipt);
                    if (
                      !command.success ||
                      command.data.status !== "succeeded" ||
                      command.data.exitCode !== 0 ||
                      command.data.outcomeUnknown === true ||
                      !command.data.stdout.trim()
                    )
                      return false;
                  }
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
    const currentReviews = receipts.filter(
      (action) =>
        action.taskId === taskId &&
        (action.dispatchedRevision ?? action.preparedRevision ?? 0) === revision,
    );
    if (
      current &&
      claimsPendingReview(delivery ?? task.result ?? "") &&
      currentReviews.some((action) => action.status === "succeeded" && useful(action.result)) &&
      !currentReviews.some((action) => ["awaiting_review", "executing"].includes(action.status))
    ) {
      checks.push({ criterionId: REVIEWED_ACTION_REPORT, passed: false, evidenceIds: [] });
      remaining.push(
        "The report says approval is still pending, but the current reviewed action has already completed. Correct the report from its actual receipt without repeating the effect.",
      );
    }
    remaining.push(...driveMissing);
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
          if (!reviewed) {
            const attached = ops.find(
              (op) =>
                op.toolName === "attach_saved_file" &&
                op.revision === revision &&
                op.status === "succeeded" &&
                object(op.receipt)?.fileId === fileId &&
                object(op.receipt)?.sha256 === sha256 &&
                object(op.receipt)?.attachment === true,
            );
            if (attached) {
              const previous = await documentReview.previousDelivery(owner, fileId, sha256);
              if (previous) {
                reviewed = true;
                missingPages = [];
                evidenceIds = [attached.id, ...previous.receiptIds];
              }
            }
          }
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
    if (pendingDialogs.size)
      remaining.push(
        "Answer the pending browser dialog using its exact dialogId and verify the page result before completing this task.",
      );
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
