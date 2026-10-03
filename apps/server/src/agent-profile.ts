import { z } from "zod";
import {
  type AgentProfilePatch,
  agentProfilePatchSchema,
  type EffectiveAgentProfile,
  type ProfileOrigin,
  type ProfileScope,
  profileScopeSchema,
} from "../../../packages/domain/src/agent.ts";
import { DEFAULT_AGENT_PROFILE } from "../../../packages/domain/src/brand.ts";
import { bindingHash, type InboxMessage } from "./conversation-inbox.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { RevisionHistory } from "./memory-history.ts";

type ProfileRecord = {
  id: string;
  revision: number;
  fields: AgentProfilePatch;
  origin?: ProfileOrigin;
  updatedAt: string;
  restoredFrom?: number;
};
const originSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settings") }).strict(),
  z.object({ kind: z.literal("chat"), messageId: z.string().min(1).max(256) }).strict(),
]);
const changeSchema = z
  .object({
    scope: profileScopeSchema,
    expectedRevision: z.number().int().min(0),
    requestId: z.string().min(1).max(256),
    origin: originSchema,
    patch: agentProfilePatchSchema,
  })
  .strict();

/** These commands are an authority boundary, not a search for preference words.
 * Every clause before a work request must be understood in full. Unknown narrative
 * is left to ordinary conversation; it never grants a model permission to write. */
const preferenceScopePrefix =
  /^(?:neste chat|nesta conversa|(?:in |for )?this chat|(?:in |for )?this conversation)[,:]?\s+/i;
function scopedPreference(text: string) {
  let conversation = false;
  const suffix =
    /\s+(?:neste chat|nesta conversa|(?:in |for )?this chat|(?:in |for )?this conversation)$/i;
  if (preferenceScopePrefix.test(text)) {
    conversation = true;
    text = text.replace(preferenceScopePrefix, "");
  }
  if (suffix.test(text)) {
    conversation = true;
    text = text.replace(suffix, "");
  }
  return { text: text.replace(/^(?:please\s+|por favor[,]?\s*)/i, ""), conversation };
}
const workCommand =
  /^(?:make|create|draft|prepare|send|find|check|research|write|book|read|open|edit|fill|build|fa[cç]a|crie|envie|encontre|verifique|pesquise|escreva|reserve|leia|abra|edite|preencha)\s+/i;
// Only this complete, bounded mixed shorthand has unambiguous local parsing.
// Arbitrary work prose can narrow/revoke an earlier preference, so preserve it
// for normal conversation without performing an automatic profile write.
const simplePlanCommand =
  /^(?:(?:fa[cç]a|crie|prepare) (?:um )?plano(?: para (?:hoje|amanh[aã]|a pr[oó]xima semana))?|(?:make|create|prepare) (?:a )?plan(?: for (?:today|tomorrow|next week))?)$/i;
const styleCommands: [RegExp, AgentProfilePatch][] = [
  [/^(?:curt[oa]s?|short|brief|concise)$/i, { responseLength: "concise" }],
  [/^(?:detalhad[oa]s?|detailed)$/i, { responseLength: "detailed" }],
  [/^(?:formal|formalmente)$/i, { formality: "formal" }],
  [/^(?:informal|casual)$/i, { formality: "casual" }],
  [/^(?:(?:mais |more )?(?:descontra[ií]d[oa]|relaxed))$/i, { formality: "casual", tone: "warm" }],
  [/^(?:sem emojis|no emojis|without emojis)$/i, { emojis: false }],
  [/^(?:com emojis|use emojis|with emojis)$/i, { emojis: true }],
  [/^(?:sem humor|no humor|without humor)$/i, { humor: "none" }],
  [
    /^(?:(?:com |with )?(?:humor leve|bom humor|mais humor|light humor|more humor)|funny)$/i,
    { humor: "light" },
  ],
  [
    /^(?:use (?:t[oó]picos|listas|bullet(?: points)?s?)|respostas estruturadas|structured (?:replies|answers))$/i,
    { textStyle: "structured" },
  ],
  [
    /^(?:texto simples|sem listas|plain (?:text|replies)|no bullet(?: points)?s?)$/i,
    { textStyle: "plain" },
  ],
  [/^(?:mais diret[oa]|more direct)$/i, { tone: "concise" }],
];
const languages: [RegExp, string][] = [
  [/^(?:portugu[eê]s|portuguese)$/i, "pt-BR"],
  [/^(?:ingl[eê]s|english)$/i, "en-US"],
  [/^(?:alem[aã]o|german|deutsch)$/i, "de-DE"],
  [/^(?:franc[eê]s|french|français)$/i, "fr-FR"],
  [/^(?:espanhol|spanish|español)$/i, "es-ES"],
  [/^(?:italiano|italian)$/i, "it-IT"],
  [/^(?:japon[eê]s|japanese)$/i, "ja-JP"],
];
function preferenceClause(text: string): AgentProfilePatch | null {
  const user = text.match(
    /^(?:me chame (?:de\s+)?|pode me chamar (?:de\s+)?|call me\s+|my preferred name is\s+)(.+)$/i,
  );
  const assistant = text.match(
    /^(?:seu nome (?:agora\s+)?(?:é|sera|será)|your name (?:now\s+)?is|call yourself)\s+(.+)$/i,
  );
  const named = user ?? assistant;
  if (named) {
    const value = named[1].trim();
    // Names are bounded display data. Do not swallow narrative punctuation or instructions.
    if (
      value.length > 80 ||
      !/^[\p{L}\p{N}][\p{L}\p{N}'’-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’-]*){0,3}$/u.test(value)
    )
      return null;
    return user ? { preferredUserName: value } : { assistantName: value };
  }
  const style = text.replace(/^(?:responda|respond|fale|speak|seja|be)\s+/i, "");
  if (
    style === text &&
    !/^(?:em|in|idioma|language|use|sem|no|without|com|with|mais|more|texto|respostas|plain|structured)\s+/i.test(
      text,
    )
  )
    return null;
  if (/^be casual$/i.test(text)) return { formality: "casual", tone: "warm" };
  const language = style.replace(/^(?:em|in|idioma|language)\s+/i, "");
  for (const [expression, locale] of languages)
    if (expression.test(language)) return { language: locale };
  for (const [expression, patch] of styleCommands) if (expression.test(style)) return patch;
  return null;
}

/** Conservative explicit commands only; the full original request still goes to work. */
export function profileIntent(
  text: string,
): { patch: AgentProfilePatch; conversation: boolean; hasWork: boolean } | null {
  const patch: AgentProfilePatch = {};
  text = text.trim();
  let conversation = preferenceScopePrefix.test(text);
  text = text.replace(preferenceScopePrefix, "");
  const personality = text.match(
    /^(?:sua personalidade|personalidade|your personality|personality)\s*:\s*([\s\S]+)$/i,
  );
  if (personality) {
    const value = personality[1].trim();
    return value.length <= 1500
      ? { patch: { personality: value }, conversation, hasWork: false }
      : null;
  }
  const clauses = text.split(/\s*(?:[.!;,\n]+|\s+(?:e|and)\s+)\s*/i).filter(Boolean);
  for (const [index, raw] of clauses.entries()) {
    const clause = scopedPreference(raw.replace(/^(?:e|and)\s+/i, ""));
    if (workCommand.test(clause.text)) {
      const fields = Object.keys(patch);
      return fields.length &&
        fields.every((field) => field === "preferredUserName" || field === "assistantName") &&
        index === clauses.length - 1 &&
        simplePlanCommand.test(raw)
        ? { patch, conversation, hasWork: true }
        : null;
    }
    const fields = preferenceClause(clause.text);
    if (!fields) return null;
    Object.assign(patch, fields);
    conversation ||= clause.conversation;
  }
  return Object.keys(patch).length ? { patch, conversation, hasWork: false } : null;
}
function resetIntent(text: string): { conversation: boolean } | null {
  const explicit = scopedPreference(text.trim().replace(/[.!]$/, ""));
  if (
    !/^(?:(?:reset|restore) (?:my |the )?(?:agent )?(?:profile|preferences|personality)(?: to (?:the )?defaults)?|restaur(?:e|ar) (?:meu |o |as minhas )?(?:perfil|prefer[eê]ncias|personalidade)(?: (?:para o padr[aã]o|padr[aã]o))?)$/i.test(
      explicit.text,
    )
  )
    return null;
  return { conversation: explicit.conversation };
}
export class AgentProfile {
  private readonly revisions: RevisionHistory<ProfileRecord>;
  constructor(private readonly db: Store) {
    this.revisions = new RevisionHistory(db, "profile-history");
  }
  private id(scope: ProfileScope) {
    return scope.kind === "global" ? "global" : `conversation:${scope.threadId}`;
  }
  private async ensure(owner: string) {
    const old = await this.db.get<{ name?: string; tone?: string }>(
      owner,
      "agent-settings",
      "identity",
    );
    const fields = agentProfilePatchSchema.parse({
      ...(old?.name ? { assistantName: old.name } : {}),
      ...(["warm", "concise", "thoughtful"].includes(old?.tone ?? "") ? { tone: old?.tone } : {}),
    });
    await this.db.insertIfAbsent(owner, "agent-profiles", {
      id: "global",
      revision: 0,
      fields,
      updatedAt: new Date().toISOString(),
    });
  }
  async get(owner: string, threadId?: string): Promise<EffectiveAgentProfile> {
    await this.ensure(owner);
    const global = (await this.db.get<ProfileRecord>(owner, "agent-profiles", "global"))!;
    const conversation = threadId
      ? await this.db.get<ProfileRecord>(owner, "agent-profiles", `conversation:${threadId}`)
      : null;
    return {
      fields: { ...DEFAULT_AGENT_PROFILE, ...global.fields, ...conversation?.fields },
      revisions: { global: global.revision, conversation: conversation?.revision ?? 0 },
      global: global.fields,
      conversation: conversation?.fields ?? {},
      origin: conversation?.origin ?? global.origin,
    };
  }
  async history(
    owner: string,
    rawScope: ProfileScope,
    options: { cursor?: string; limit?: number } = {},
  ) {
    const scope = profileScopeSchema.parse(rawScope);
    await this.get(owner, scope.kind === "conversation" ? scope.threadId : undefined);
    const value = await this.db.get<ProfileRecord>(owner, "agent-profiles", this.id(scope));
    if (value)
      await this.db.insertIfAbsent(
        owner,
        "profile-history",
        this.revisions.entry(value.id, value.revision, value, "migrate", value.updatedAt),
      );
    return this.revisions.page(owner, this.id(scope), options);
  }
  async restore(
    owner: string,
    raw: {
      scope: ProfileScope;
      revision: number;
      expectedRevision: number;
      requestId: string;
      origin: ProfileOrigin;
    },
  ) {
    const input = changeSchema
      .omit({ patch: true })
      .extend({ revision: z.number().int().min(0) })
      .parse(raw);
    // The authenticated settings channel is the deliberate restoration authority.
    if (input.origin.kind !== "settings")
      throw new AppError("Restore profile revisions in authenticated settings", 403);
    await this.authorizeOrigin(owner, input.origin, input.scope);
    await this.ensure(owner);
    const id = this.id(input.scope);
    const entry = await this.revisions.get(owner, id, input.revision);
    if (!entry) throw new AppError("Profile revision not found", 404);
    const previous = await this.db.get<ProfileRecord>(owner, "agent-profiles", id);
    if (!previous) throw new AppError("Profile not found", 404);
    const value = {
      id,
      fields: agentProfilePatchSchema.parse(entry.value.fields),
      revision: input.expectedRevision + 1,
      origin: input.origin,
      updatedAt: new Date().toISOString(),
      restoredFrom: input.revision,
    };
    const history = this.revisions.entry(id, value.revision, value, "restore", value.updatedAt);
    const result = await this.db.durableMutation(
      owner,
      `profile:${input.requestId}`,
      bindingHash({ ...input, action: "restore" }),
      [
        {
          kind: "agent-profiles",
          id,
          mode: "replace",
          expected: { revision: input.expectedRevision },
          value,
        },
        { kind: "profile-history", id: history.id, mode: "insert", value: history },
      ],
    );
    if (result.status === "binding_conflict")
      throw new AppError("This profile request ID was already used", 409);
    if (result.status === "revision_conflict")
      throw new AppError("Agent preferences changed. Refresh before restoring", 409);
    return this.get(owner, input.scope.kind === "conversation" ? input.scope.threadId : undefined);
  }
  private async authorizeOrigin(
    owner: string,
    origin: ProfileOrigin,
    scope: ProfileScope,
    patch?: AgentProfilePatch,
    source?: { threadId: string; runId: string },
  ) {
    if (origin.kind === "settings") {
      if (scope.kind === "conversation" && !(await this.db.get(owner, "threads", scope.threadId)))
        throw new AppError("Conversation not found", 404);
      return;
    }
    if (!source)
      throw new AppError("Chat profile changes require the current conversation and run", 403);
    const candidate = await this.db.get<InboxMessage>(
      owner,
      "conversation-inbox",
      `${source.threadId}:${origin.messageId}`,
    );
    const message =
      candidate?.messageId === origin.messageId &&
      candidate.runId === source.runId &&
      (scope.kind !== "conversation" || candidate.threadId === scope.threadId)
        ? candidate
        : null;
    const intent = message ? profileIntent(message.text) : null;
    if (
      !message ||
      (patch &&
        (!intent ||
          Object.entries(patch).some(
            ([key, value]) => intent.patch[key as keyof AgentProfilePatch] !== value,
          )))
    )
      throw new AppError(
        "Profile changes must match the authenticated user's explicit preference",
        403,
      );
    if (intent && (scope.kind === "conversation") !== intent.conversation)
      throw new AppError("Profile scope must match the user's request", 403);
    if (!patch) {
      const reset = resetIntent(message.text);
      if (!reset) throw new AppError("Reset requires the user's explicit profile request", 403);
      if ((scope.kind === "conversation") !== reset.conversation)
        throw new AppError("Profile scope must match the user's reset request", 403);
    }
  }
  async update(
    owner: string,
    raw: {
      scope: ProfileScope;
      patch: AgentProfilePatch;
      expectedRevision: number;
      requestId: string;
      origin: ProfileOrigin;
    },
    source?: { threadId: string; runId: string },
  ): Promise<EffectiveAgentProfile> {
    const input = changeSchema.parse(raw);
    if (!Object.keys(input.patch).length)
      throw new AppError("Choose a profile field to change", 422);
    return this.change(owner, input, false, source);
  }
  async reset(
    owner: string,
    raw: Omit<Parameters<AgentProfile["update"]>[1], "patch">,
    source?: { threadId: string; runId: string },
  ) {
    const input = changeSchema.omit({ patch: true }).parse(raw);
    return this.change(owner, { ...input, patch: {} }, true, source);
  }
  private async change(
    owner: string,
    input: z.infer<typeof changeSchema>,
    reset: boolean,
    source?: { threadId: string; runId: string },
  ) {
    await this.ensure(owner);
    await this.authorizeOrigin(
      owner,
      input.origin,
      input.scope,
      reset ? undefined : input.patch,
      source,
    );
    const id = this.id(input.scope);
    await this.db.insertIfAbsent(owner, "agent-profiles", {
      id,
      revision: 0,
      fields: {},
      updatedAt: new Date().toISOString(),
    });
    const previous = (await this.db.get<ProfileRecord>(owner, "agent-profiles", id))!;
    await this.db.insertIfAbsent(
      owner,
      "profile-history",
      this.revisions.entry(id, previous.revision, previous, "migrate", previous.updatedAt),
    );
    const value = {
      id,
      revision: input.expectedRevision + 1,
      fields: reset ? {} : { ...previous.fields, ...input.patch },
      origin: input.origin,
      ...(source ? { source } : {}),
      updatedAt: new Date().toISOString(),
    };
    const history = this.revisions.entry(
      id,
      value.revision,
      value,
      reset ? "reset" : "edit",
      value.updatedAt,
    );
    const result = await this.db.durableMutation<ProfileRecord>(
      owner,
      `profile:${input.requestId}`,
      bindingHash({ ...input, reset, source }),
      [
        {
          kind: "agent-profiles",
          id,
          mode: "replace",
          expected: { revision: input.expectedRevision },
          value,
        },
        { kind: "profile-history", id: history.id, mode: "insert", value: history },
      ],
    );
    if (result.status === "binding_conflict")
      throw new AppError("This profile request ID was already used with different fields", 409);
    if (result.status === "revision_conflict")
      throw new AppError("Agent preferences changed. Refresh before saving again.", 409);
    return this.get(owner, input.scope.kind === "conversation" ? input.scope.threadId : undefined);
  }
}
