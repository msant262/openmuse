import { randomUUID } from "node:crypto";
import type { SourceCoverage } from "../../../../packages/domain/src/proactivity.ts";
import { bindingHash } from "../conversation-inbox.ts";
import type { AgentService } from "../engine/service.ts";
import type { ProactivityEvents } from "./events.ts";

type Snapshot = { id: string; version?: string; connectionId?: string; coverage: SourceCoverage };
/** Poll source versions, enqueue changes, then let the normal worker reread evidence.
 * Native Gmail uses historyId; primary-calendar reads report their exact coverage.
 */
export class ProactivitySourceEvents {
  constructor(
    private readonly service: AgentService,
    private readonly events: ProactivityEvents,
  ) {}
  async poll(owner: string, now: number) {
    const { db } = this.service;
    if (
      this.service.config.mode !== "live" ||
      (await this.service.runtimePause.get(owner)).paused ||
      !(await this.service.proactivity.settings.get(owner)).enabled
    )
      return;
    await db.insertIfAbsent(owner, "proactivity-source-poll", {
      id: "poll",
      nextAt: "1970-01-01T00:00:00.000Z",
      token: "",
    });
    const previous = await db.get<{ id: string; nextAt: string; token: string }>(
      owner,
      "proactivity-source-poll",
      "poll",
    );
    if (!previous || Date.parse(previous.nextAt) > now) return;
    const token = randomUUID();
    if (
      !(await db.compareAndSwap(
        owner,
        "proactivity-source-poll",
        "poll",
        { token: previous.token, nextAt: previous.nextAt },
        { token, nextAt: new Date(now + 300000).toISOString() },
      ))
    )
      return;
    const observedAt = new Date(now).toISOString();
    const signal = AbortSignal.timeout(30000);
    const persist = async (source: "mail" | "calendar", snapshot: Snapshot) => {
      if (
        (await db.get<{ token: string }>(owner, "proactivity-source-poll", "poll"))?.token !== token
      )
        return;
      if ((await this.service.runtimePause.get(owner)).paused) return;
      const last = await db.get<Snapshot>(owner, "proactivity-source-state", source);
      if (
        snapshot.version &&
        snapshot.connectionId &&
        (last?.version !== snapshot.version || last.connectionId !== snapshot.connectionId)
      )
        await this.events.enqueue(owner, {
          source,
          key: snapshot.connectionId,
          revision: snapshot.version,
          observedAt,
        });
      await db.put(owner, "proactivity-source-state", { ...last, ...snapshot, id: source });
    };
    try {
      const mail = await this.service.workspace.proactivityMailVersion(owner, signal);
      await persist("mail", {
        id: "mail",
        ...(mail.authority ? { version: mail.version, connectionId: mail.authority.id } : {}),
        coverage: {
          complete: mail.status === "fresh",
          status: mail.status,
          observedAt,
          detail: "Mailbox change token only; changed mail is reread by the review worker",
        },
      });
    } catch (error) {
      await persist("mail", {
        id: "mail",
        coverage: {
          complete: false,
          status: "unavailable",
          observedAt,
          detail: error instanceof Error ? error.message : String(error),
        },
      });
    }
    const calendar = await this.service.workspace
      .readCalendar(
        owner,
        {
          timeMin: observedAt,
          timeMax: new Date(now + 7 * 86400000).toISOString(),
          timeZone: this.service.routines.timezone,
        },
        signal,
      )
      .catch((error) => ({
        status: "unavailable" as const,
        events: [],
        metadata: { complete: false },
        error: String(error),
      }));
    const connectionId =
      "connectionId" in calendar.metadata ? String(calendar.metadata.connectionId) : undefined;
    await persist("calendar", {
      id: "calendar",
      ...(connectionId ? { connectionId, version: bindingHash(calendar.events) } : {}),
      coverage: {
        complete: calendar.metadata.complete,
        status: calendar.status,
        observedAt,
        detail:
          "Primary calendar only, next seven days; partial reads do not prove that an event was cancelled",
      },
    });
    if (
      connectionId &&
      calendar.metadata.complete &&
      !(await this.service.runtimePause.get(owner)).paused
    ) {
      const keys = new Set<string>();
      for (const event of calendar.events) {
        const key = `event:${connectionId}:${event.id}`;
        keys.add(key);
        if (Date.parse(event.start) <= now) continue;
        await this.events.enqueue(owner, {
          source: "calendar",
          key,
          revision: bindingHash(event),
          intent: "scheduled",
          dueAt: new Date(Date.parse(event.start) - 3600000).toISOString(),
          expiresAt: event.start,
          observedAt,
        });
      }
      const pending = await db.recordPage<{ source: string; key: string }>(
        owner,
        "proactivity-events",
        { field: "status", value: "pending", limit: 100 },
      );
      for (const event of pending.entries)
        if (
          event.source === "calendar" &&
          event.key.startsWith(`event:${connectionId}:`) &&
          !keys.has(event.key)
        )
          await this.events.retire(
            owner,
            "calendar",
            event.key,
            "Event cancelled or outside current calendar window",
          );
    }
  }
}
