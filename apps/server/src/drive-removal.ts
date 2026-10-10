import type { ActionProposal } from "../../../packages/domain/src/index.ts";
import type { JournalOperation } from "./engine/task-journal.ts";
import {
  type DriveSearchResult,
  normalizedDriveName,
  observedDriveSearch,
} from "./google-drive-search.ts";

export type DriveRemoval = {
  verified: true;
  id: string;
  name: string;
  trashed: boolean;
  deleted: boolean;
};
type Binding = {
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
  fingerprint: string;
};
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function driveRemovalRequest(prompt: string) {
  const quoted = /“([^”]+)”|‘([^’]+)’|"([^"]+)"|'([^']+)'|`([^`]+)`/g;
  const names = [...prompt.matchAll(quoted)]
    .map((match) => match.slice(1).find(Boolean)!)
    .filter(Boolean);
  const instruction = prompt.replace(quoted, " ");
  const ids = [
    ...new Set(
      [
        ...prompt.matchAll(
          /https:\/\/(?:drive|docs)\.google\.com\/(?:file\/d\/|(?:document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/|drive\/folders\/)([a-z0-9_-]+)/gi,
        ),
      ].map((match) => match[1]),
    ),
  ];
  if (!/\b(?:drive|google\s+(?:docs|sheets|slides))\b/i.test(instruction) && !ids.length)
    return undefined;
  const deletion = [
    ...instruction.matchAll(
      /\b(?:delete|remove|trash|apague|apaga|apagar|exclua|excluir|exclui|deleta|deletar|remova|remover|lixeira)\b/gi,
    ),
  ].some((match) => {
    const prefix =
      instruction
        .slice(Math.max(0, match.index! - 60), match.index)
        .split(/[.!?;\n]/)
        .at(-1) ?? "";
    if (/(?:n[aã]o|not|don't|do not|never|nunca|sem)(?:\s+\S+){0,3}\s*$/i.test(prefix))
      return false;
    const target =
      /\b(?:e-?mails?|mensagens?|messages?|eventos?|events?|compromissos?|appointments?|arquivos?|files?|documentos?|documents?|pastas?|folders?|planilhas?|spreadsheets?|apresenta[çc][aã]o|apresenta[çc][oõ]es|presentations?|drive|docs|sheets|slides)\b/i.exec(
        instruction.slice(match.index! + match[0].length).split(/[.!?;\n]/)[0],
      );
    return (
      !target ||
      !/^(?:e-?mail|mensage|message|evento?|event|compromisso|appointment)/i.test(target[0])
    );
  });
  if (
    !deletion ||
    /\b(?:permissions?|permiss[oõ]es|permiss[aã]o|access|acesso|compartilhamento)\b/i.test(
      instruction,
    )
  )
    return undefined;
  return {
    names: [...new Set(names)],
    ids,
    accounts: [...new Set(instruction.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [])].map(
      (account) => account.toLowerCase(),
    ),
    allMatches:
      names.length > 1 ||
      /\b(?:todos|todas|all|every|each|arquivos|files|documentos|documents|apresenta[çc][oõ]es|presentations|planilhas|spreadsheets)\b/i.test(
        instruction,
      ),
  };
}

export function confirmedDriveRemoval(action: ActionProposal, binding?: Binding) {
  if (binding?.serverId !== "google-workspace" || action.status !== "succeeded" || !action.result)
    return undefined;
  if (
    binding.tool !== "drive.files.delete" &&
    !(binding.tool === "drive.files.update" && binding.args.trashed === true)
  )
    return undefined;
  try {
    const receipt = record(JSON.parse(action.result));
    const change = record(receipt?.driveRemoval);
    if (
      change?.verified !== true ||
      change.id !== binding.args.fileId ||
      typeof change.name !== "string" ||
      !(change.trashed === true || change.deleted === true) ||
      typeof receipt?.account !== "string"
    )
      return undefined;
    return {
      ...(change as DriveRemoval),
      account: receipt.account,
      connectionId: binding.fingerprint,
    };
  } catch {
    return undefined;
  }
}

/** Keep the union of the original matching IDs. Later searches after a write
 * cannot shrink the requested selection or make an unfinished group pass. */
export function driveRemovalEvidence(
  prompt: string,
  operations: JournalOperation[],
  actions: ActionProposal[],
  bindings: Map<string, Binding | undefined>,
) {
  const request = driveRemovalRequest(prompt);
  if (!request)
    return {
      complete: false,
      evidenceIds: [] as string[],
      missing: ["Confirm the requested Drive removal with a provider receipt."],
    };
  const sameName = (name: string, target: string) =>
    normalizedDriveName(name) === normalizedDriveName(target);
  const accountMatches = (account: string) =>
    !request.accounts.length || request.accounts.includes(account.toLowerCase());
  const confirmed = actions.flatMap((action) => {
    const removal = confirmedDriveRemoval(action, bindings.get(action.id));
    return removal && accountMatches(removal.account) ? [{ ...removal, actionId: action.id }] : [];
  });
  const searches = operations.filter(
    (op) =>
      op.status === "succeeded" &&
      op.toolName === "search_drive" &&
      observedDriveSearch(op.receipt),
  );
  const selected = new Map<string, DriveSearchResult["files"][number]>();
  const covered = new Set<string>();
  const selectionAccounts = new Set<string>();
  const pages = new Map<string, Map<number, DriveSearchResult>>();
  for (const op of searches) {
    const result = op.receipt as DriveSearchResult;
    for (const file of result.files) {
      if (!accountMatches(file.account)) continue;
      if (
        request.names.length
          ? request.names.some((name) => sameName(file.name, name))
          : file.match !== "related"
      )
        selected.set(`${file.connectionId}:${file.id}`, file);
    }
    const args = record(op.args);
    const key = JSON.stringify([
      result.query,
      args?.account,
      args?.parentId,
      args?.kind,
      args?.recursive,
      result.totalMatches,
    ]);
    const group = pages.get(key) ?? new Map<number, DriveSearchResult>();
    const offset = Number(args?.offset ?? 0);
    if (!group.has(offset)) group.set(offset, result);
    pages.set(key, group);
  }
  for (const group of pages.values()) {
    const first = group.get(0);
    if (!first) continue;
    const files: DriveSearchResult["files"] = [];
    let offset = 0,
      complete = false;
    for (;;) {
      const page = group.get(offset);
      if (!page || page.returnedCount !== page.files.length) break;
      files.push(...page.files);
      const end = offset + page.files.length;
      if (page.nextOffset === null) {
        complete = end === first.totalMatches;
        break;
      }
      if (page.nextOffset !== end || end <= offset) break;
      offset = end;
    }
    if (complete) {
      for (const account of first.accounts)
        if (accountMatches(account.account)) selectionAccounts.add(account.account.toLowerCase());
      for (const name of request.names)
        if (
          sameName(first.query, name) ||
          files.some((file) => accountMatches(file.account) && sameName(file.name, name))
        )
          covered.add(name);
    }
  }
  const missing: string[] = [];
  if (request.allMatches) {
    if (!request.names.length && !request.ids.length) {
      const accounts = request.accounts.length ? request.accounts : [undefined];
      for (const account of accounts)
        if (account ? !selectionAccounts.has(account) : !selectionAccounts.size)
          missing.push(
            `Read the complete requested Drive selection${account ? ` in account ${account}` : ""}, including all shortlist pages.`,
          );
    }
    for (const name of request.names)
      if (!covered.has(name))
        missing.push(
          `Read the complete Drive selection matching “${name}”, including all shortlist pages.`,
        );
    for (const file of selected.values())
      if (
        !confirmed.some(
          (change) => change.connectionId === file.connectionId && change.id === file.id,
        )
      )
        missing.push(
          `Remove the remaining selected Drive file “${file.name}” (fileId ${file.id}, account ${file.account}) only through its approval card, then confirm its provider receipt.`,
        );
  }
  for (const name of request.names)
    if (!confirmed.some((change) => sameName(change.name, name)))
      missing.push(`Confirm the requested removal of “${name}” in Google Drive.`);
  if (!confirmed.length) missing.push("No requested Drive file has a confirmed removal receipt.");
  for (const id of request.ids)
    if (!confirmed.some((change) => change.id === id))
      missing.push(`Confirm removal of the explicitly requested Drive fileId ${id}.`);
  const evidenceIds = confirmed
    .filter((change) =>
      request.names.length
        ? request.names.some((name) => sameName(change.name, name))
        : request.ids.length
          ? request.ids.includes(change.id)
          : !request.allMatches || selected.has(`${change.connectionId}:${change.id}`),
    )
    .map((change) => change.actionId);
  return { complete: missing.length === 0 && evidenceIds.length > 0, evidenceIds, missing };
}
