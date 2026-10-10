import { z } from "zod";
import {
  browserDialogInputSchema,
  browserDialogSchema,
} from "../../../../packages/domain/src/browser-dialog.ts";
import type { ActionProposal } from "../../../../packages/domain/src/index.ts";
import { snapshotSchema } from "../browser-contract.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import type { JournalOperation } from "./task-journal.ts";

const removal =
  /\b(?:delete|remove|trash|erase|exclua|excluir|exclui|apague|apagar|apaga|remova|remover|deleta|deletar|losche|loschen|entferne|entfernen)\b/gi;
const quoted = /“([^”]+)”|‘([^’]+)’|"([^"]+)"|'([^']+)'|`([^`]+)`/g;
const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function pageUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** A bounded page instruction, not a classification of arbitrary deletion
 * goals. Connector requests retain their own provider readback contracts. */
export function browserRemovalRequest(prompt: string) {
  const names = [...prompt.matchAll(quoted)].flatMap((match) => {
    const name = match.slice(1).find(Boolean);
    return name ? [name] : [];
  });
  const urls = [
    ...new Set(
      [...prompt.matchAll(/https?:\/\/[^\s<>"'“”‘’`]+/gi)]
        .map((match) => pageUrl(match[0].replace(/[.,;]+$/, "")))
        .filter((url): url is string => Boolean(url)),
    ),
  ];
  const url = urls[0];
  const instruction = normalize(
    prompt.replace(quoted, " ").replace(/https?:\/\/[^\s<>"'“”‘’`]+/gi, " "),
  );
  if (
    urls.length !== 1 ||
    !url ||
    /^https:\/\/(?:drive|docs)\.google\.com\//i.test(url) ||
    !/\b(?:page|pagina|site|browser|navegador|webseite|seite)\b/.test(instruction) ||
    /\b(?:google\s+(?:drive|docs|sheets|slides)|drive|gmail|calendar|calendario|agenda)\b/.test(
      instruction,
    )
  )
    return undefined;
  const requested = [...instruction.matchAll(removal)].some((match) => {
    const prefix =
      instruction
        .slice(Math.max(0, (match.index ?? 0) - 60), match.index)
        .split(/[.!?;\n]/)
        .at(-1) ?? "";
    return !/(?:nao|not|don't|do not|never|nunca|sem|nicht)(?:\s+\S+){0,3}\s*$/.test(prefix);
  });
  return requested ? { url, names } : undefined;
}

const dialogBinding = z
  .object({
    sessionId: z.uuid(),
    input: browserDialogInputSchema,
    url: z.url(),
    dialog: browserDialogSchema,
  })
  .strict();
const answeredSnapshot = snapshotSchema.extend({
  response: z.object({ dialogId: z.uuid(), accept: z.boolean() }),
});

function newRemovalConfirmation(before: string, after: string) {
  const old = new Set(
    normalize(before)
      .split(/[.!?\n]+/)
      .map((part) => part.trim()),
  );
  return normalize(after)
    .split(/[.!?\n]+/)
    .some((part) => {
      const line = part.trim();
      if (
        old.has(line) ||
        /\b(?:nao|not|never|nunca|nicht|will|would|could|should|can|may|vou|sera|serao|pode|podera|aguardando|pending|failed|falhou|recusad[oa]|denied)\b/.test(
          line,
        )
      )
        return false;
      // A new, explicit resource-removal confirmation, not a generic success
      // word, disappearance of a dialog, or text already present before dispatch.
      return /\b(?:documento?|documents?|arquivos?|files?|itens?|items?|pasta|folder|registro|record|event|evento|dokument|datei)\b[^\n.!?]{0,160}\b(?:deleted|removed|trashed|erased|excluid[oa]s?|apagad[oa]s?|removid[oa]s?|geloscht|entfernt)\b/.test(
        line,
      );
    });
}

/** Confirm the exact reviewed deletion, using private ActionService bindings
 * and the owned journal's pre-click page. Never dispatch, rewrite receipts, or
 * accept a navigation/read as a mutation. DOM-only deletion remains unverified
 * until its adapter can supply an equivalent approved, bound effect receipt. */
export async function browserRemovalEvidence(
  db: Store,
  owner: string,
  taskId: string,
  revision: number,
  prompt: string,
  operations: JournalOperation[],
  actions: ActionProposal[],
): Promise<string[]> {
  const request = browserRemovalRequest(prompt);
  if (!request) return [];
  const ops = operations.filter(
    (op) =>
      op.taskId === taskId &&
      op.revision === revision &&
      op.status === "succeeded" &&
      !op.parentOperationId &&
      !op.nativeEnvelope,
  );
  const evidence: string[] = [];
  for (const action of actions) {
    if (
      action.taskId !== taskId ||
      action.kind !== "external.action" ||
      action.data.tool !== "browser.dialog" ||
      action.status !== "succeeded" ||
      action.error ||
      action.dispatchedRevision !== revision ||
      action.data.requiresHumanApproval !== true ||
      !action.result
    )
      continue;
    const saved = await db.get<{ tool: string; hash: string; binding: unknown }>(
      owner,
      "external-action-bindings",
      action.id,
    );
    if (saved?.tool !== "browser.dialog" || saved.hash !== action.hash) continue;
    const bound = dialogBinding.safeParse(saved.binding);
    if (!bound.success) continue;
    const binding = bound.data;
    if (
      pageUrl(binding.url) !== request.url ||
      !binding.input.accept ||
      binding.input.dialogId !== binding.dialog.id ||
      binding.dialog.type !== "confirm" ||
      binding.dialog.truncated ||
      !binding.dialog.requiresApproval ||
      !normalize(binding.dialog.message).match(removal) ||
      !request.names.every((name) => normalize(binding.dialog.message).includes(normalize(name)))
    )
      continue;
    let result: z.output<typeof answeredSnapshot>;
    try {
      result = answeredSnapshot.parse(JSON.parse(action.result));
    } catch {
      continue;
    }
    if (
      result.sessionId !== binding.sessionId ||
      pageUrl(result.url) !== request.url ||
      result.response.dialogId !== binding.dialog.id ||
      !result.response.accept
    )
      continue;
    const prepared = ops.find((op) => {
      const receipt = record(op.receipt),
        args = record(op.args);
      return (
        op.toolName === "browser_dialog" &&
        op.effect &&
        receipt?.actionId === action.id &&
        receipt.approvalRequired === true &&
        receipt.sessionId === binding.sessionId &&
        args?.dialogId === binding.dialog.id &&
        args.accept === true &&
        (args.sessionId === undefined || args.sessionId === binding.sessionId) &&
        op.bindingHash === bindingHash({ name: op.toolName, args: op.args })
      );
    });
    if (!prepared) continue;
    for (const click of ops) {
      const args = record(click.args),
        act = record(args?.act);
      const opened = snapshotSchema.safeParse(click.receipt);
      if (
        click.toolName !== "browser_act" ||
        !click.effect ||
        act?.action !== "click" ||
        click.bindingHash !== bindingHash({ name: click.toolName, args: click.args }) ||
        !opened.success ||
        opened.data.sessionId !== binding.sessionId ||
        pageUrl(opened.data.url) !== request.url ||
        bindingHash(opened.data.dialog) !== bindingHash(binding.dialog) ||
        Date.parse(click.createdAt) > Date.parse(prepared.createdAt)
      )
        continue;
      const before = ops
        .flatMap((op) => {
          const snapshot = snapshotSchema.safeParse(op.receipt);
          return /^browser_(?:navigate|snapshot|act|dialog)$/.test(op.toolName) &&
            snapshot.success &&
            snapshot.data.sessionId === binding.sessionId &&
            snapshot.data.snapshotId === act.snapshotId &&
            pageUrl(snapshot.data.url) === request.url &&
            !snapshot.data.dialog &&
            !snapshot.data.truncated &&
            !snapshot.data.truncatedElements &&
            Date.parse(op.createdAt) <= Date.parse(click.createdAt)
            ? [snapshot.data]
            : [];
        })
        .find((snapshot) =>
          snapshot.elements.some(
            (element) =>
              element.number === act.element &&
              !element.disabled &&
              normalize(element.label).match(removal),
          ),
        );
      if (
        !before ||
        !request.names.every((name) => normalize(before.text).includes(normalize(name)))
      )
        continue;
      const observations = [
        { id: action.id, snapshot: result },
        ...ops.flatMap((op) => {
          if (
            op.toolName !== "browser_snapshot" ||
            !action.dispatchedAt ||
            Date.parse(op.createdAt) <= Date.parse(action.dispatchedAt)
          )
            return [];
          const snapshot = snapshotSchema.safeParse(op.receipt);
          return snapshot.success ? [{ id: op.id, snapshot: snapshot.data }] : [];
        }),
      ];
      const observed = observations.find(
        ({ snapshot }) =>
          snapshot.sessionId === binding.sessionId &&
          pageUrl(snapshot.url) === request.url &&
          !snapshot.dialog &&
          !snapshot.truncated &&
          !snapshot.truncatedElements &&
          snapshot.snapshotId !== before.snapshotId &&
          newRemovalConfirmation(before.text, snapshot.text),
      );
      if (!observed) continue;
      evidence.push(action.id);
      if (observed.id !== action.id) evidence.push(observed.id);
      break;
    }
  }
  return evidence;
}
