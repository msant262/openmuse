import { z } from "zod";
import type { ProactivitySettingsRecord } from "../../../../packages/domain/src/proactivity.ts";
import { bindingHash, type InboxMessage } from "../conversation-inbox.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

export const proactivitySettingsPatch = z
  .object({
    expectedRevision: z.number().int().min(0),
    enabled: z.boolean().optional(),
    intervalHours: z.number().min(0.25).max(168).optional(),
    requestId: z.string().min(1).max(256).optional(),
    activeHours: z
      .object({
        start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/),
        timezone: z.string().refine((value) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: value });
            return true;
          } catch {
            return false;
          }
        }, "Use an IANA timezone"),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.enabled !== undefined || v.intervalHours !== undefined || v.activeHours !== undefined,
    "Choose a setting to change",
  );
export type ChatSource = { messageId: string; threadId: string; runId: string };
export function proactivityIntent(
  text: string,
): { enabled?: boolean; intervalHours?: number } | null {
  const value = text.trim().replace(/[.!]$/, "");
  const interval = value.match(
    /^(?:review (?:my )?(?:emails|pending work|tasks)|check (?:my )?(?:emails|pending work)|revise (?:meus )?(?:e-mails|emails|pend[eê]ncias|tarefas)|revis[aã]o proativa|proactivity|proatividade|heartbeat proativo)\s+(?:every|a cada)\s+(\d+(?:[.,]\d+)?)\s+(?:hours?|horas?)$/i,
  );
  if (interval) return { intervalHours: Number(interval[1].replace(",", ".")) };
  const german = value.match(
    /^(?:pr[üu]fe|[üu]berpr[üu]fe)\s+(?:meine\s+)?(?:e-mails|emails|aufgaben|offene aufgaben)\s+alle\s+(\d+(?:[.,]\d+)?)\s+stunden?$/i,
  );
  if (german) return { intervalHours: Number(german[1].replace(",", ".")) };
  if (
    /^(?:disable|pause|desative|pause)\s+(?:proactivity|proatividade|(?:the )?proactive reviews|revis[aã]o proativa)$/i.test(
      value,
    )
  )
    return { enabled: false };
  if (
    /^(?:enable|resume|ative|retome)\s+(?:proactivity|proatividade|(?:the )?proactive reviews|revis[aã]o proativa)$/i.test(
      value,
    )
  )
    return { enabled: true };
  if (
    /^(?:deaktiviere|pausiere)\s+(?:die\s+)?(?:proaktiven? prüfungen|proaktivit[aä]t)$/i.test(value)
  )
    return { enabled: false };
  if (
    /^(?:aktiviere|setze)\s+(?:die\s+)?(?:proaktiven? prüfungen|proaktivit[aä]t)(?: fort)?$/i.test(
      value,
    )
  )
    return { enabled: true };
  return null;
}
export class ProactivitySettings {
  constructor(
    private readonly db: Store,
    private readonly defaults = { enabled: true, intervalHours: 4 },
  ) {}
  async get(owner: string): Promise<ProactivitySettingsRecord> {
    const value: ProactivitySettingsRecord = {
      id: "settings",
      revision: 0,
      ...this.defaults,
      updatedAt: new Date().toISOString(),
    };
    await this.db.insertIfAbsent(owner, "proactivity-settings", value);
    return (await this.db.get<ProactivitySettingsRecord>(
      owner,
      "proactivity-settings",
      "settings",
    ))!;
  }
  async update(owner: string, raw: unknown, source?: ChatSource) {
    const input = proactivitySettingsPatch.parse(raw);
    if (source) {
      const message = await this.db.chatSource<InboxMessage>(owner, source);
      const intent = message ? proactivityIntent(message.text) : null;
      if (
        !intent ||
        input.activeHours !== undefined ||
        Object.entries(input).some(
          ([key, value]) => (key === "enabled" || key === "intervalHours") && intent[key] !== value,
        )
      )
        throw new AppError(
          "Proactivity changes must match the authenticated user's explicit request",
          403,
        );
    }
    const previous = await this.get(owner);
    const { expectedRevision, requestId, ...patch } = input;
    const result = await this.db.durableMutation<ProactivitySettingsRecord>(
      owner,
      `proactivity-settings:${requestId ?? bindingHash(input)}`,
      bindingHash({ input, source }),
      [
        {
          kind: "proactivity-settings",
          id: "settings",
          mode: "merge",
          expected: { revision: expectedRevision },
          value: {
            ...patch,
            revision: expectedRevision + 1,
            updatedAt: new Date().toISOString(),
            origin: source ? { kind: "chat", messageId: source.messageId } : { kind: "settings" },
          },
        },
      ],
    );
    if (result.status === "binding_conflict" || result.status === "revision_conflict")
      throw new AppError("Proactivity settings changed; read the current revision", 409);
    // The cadence uses lastReviewedAt plus current settings, so changing the interval
    // takes effect without replacing a queued review or catching up old intervals.
    return result.values[0] ?? previous;
  }
}
