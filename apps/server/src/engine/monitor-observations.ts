import { createHash } from "node:crypto";
import type { AgentTask, Monitor } from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import { LostLeaseError } from "./worker.ts";
export type MonitorPage = {
  url: string;
  title: string;
  text: string;
  sessionId?: string;
  truncated?: boolean;
  contentHash?: string;
  sourceLength?: number;
  products?: { name: string; price: number; currency: string }[];
};
type Occurrence = { id: string; taskId: string; title: string; body: string; published: boolean };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function assessMonitor(monitor: Monitor, page: MonitorPage) {
  const text = page.text.replace(/\s+/g, " ").trim();
  const digest = page.contentHash ?? hash(text);
  const incomplete = Boolean(page.truncated && !page.contentHash);
  let uncertain = incomplete
    ? "Leitura parcial: mudanças fora do trecho lido não puderam ser verificadas."
    : "";
  let matched = false;
  if (monitor.condition === "change")
    matched = Boolean(monitor.lastHash && monitor.lastHash !== digest);
  else if (monitor.condition === "contains")
    matched = text.toLocaleLowerCase().includes(monitor.value.toLocaleLowerCase());
  else {
    const target = monitor.priceTarget?.trim().toLocaleLowerCase();
    const prices = (page.products ?? []).filter(
      (offer) =>
        target &&
        offer.currency === monitor.currency &&
        offer.name.trim().toLocaleLowerCase() === target,
    );
    if (prices.length === 1) matched = prices[0].price < Number(monitor.value);
    else
      uncertain =
        "Não foi possível identificar uma única oferta atual para o produto e a moeda escolhidos.";
  }
  const before = monitor.lastValue ?? "";
  let index = 0;
  while (index < Math.min(before.length, text.length, 1000) && before[index] === text[index])
    index++;
  const diff =
    matched && monitor.condition === "change"
      ? index >= 1000 || (page.truncated && index >= text.length)
        ? "Conteúdo mudou além da prévia disponível; abra a fonte para comparar."
        : `Antes: ${before.slice(Math.max(0, index - 60), index + 160)}\nAgora: ${text.slice(Math.max(0, index - 60), index + 160)}`
      : text.slice(0, 240);
  return {
    text,
    digest,
    matched,
    uncertain,
    diff,
    truncated: Boolean(page.truncated || before.length >= 1000 || text.length > 1000),
  };
}
export class MonitorObservations {
  constructor(
    readonly db: Store,
    readonly notify: (
      owner: string,
      title: string,
      body: string,
      taskId: string,
      key: string,
    ) => Promise<void>,
  ) {}
  async commit(
    owner: string,
    task: AgentTask,
    monitor: Monitor,
    page: MonitorPage,
    nextCheckAt: string,
  ) {
    const value = assessMonitor(monitor, page);
    const alert = value.matched && (monitor.condition === "change" || !monitor.matched);
    const coverageAlert = Boolean(value.uncertain && value.uncertain !== monitor.coverageWarning);
    const occurrenceId = `monitor:${monitor.id}:${monitor.checks + 1}`;
    const occurrence: Occurrence = {
      id: occurrenceId,
      taskId: task.id,
      title: monitor.title,
      body: `${value.uncertain || value.diff}\nFonte: ${page.url}`.slice(0, 1000),
      published: false,
    };
    const saved = await this.db.durableMutation(
      owner,
      `observe:${task.id}:${task.leaseId}`,
      hash(JSON.stringify([monitor.checks, value, page.url])),
      [
        {
          kind: "tasks",
          id: task.id,
          mode: "merge",
          expected: { status: "running", leaseId: task.leaseId ?? null },
          value: {},
        },
        {
          kind: "monitors",
          id: monitor.id,
          mode: "merge",
          expected: { status: "active", checks: monitor.checks },
          value: {
            checks: monitor.checks + 1,
            lastCheckedAt: new Date().toISOString(),
            lastHash: value.digest,
            lastValue: value.text.slice(0, 1000),
            matched: value.matched,
            coverageWarning: value.uncertain,
            lastDiff: value.diff,
            diffTruncated: value.truncated,
            nextCheckAt,
            error: null,
          },
        },
        ...(alert || coverageAlert
          ? [
              {
                kind: "monitor-occurrences",
                id: occurrenceId,
                mode: "insert" as const,
                value: { ...occurrence },
              },
            ]
          : []),
      ],
      [],
      true,
    );
    if (!["applied", "duplicate"].includes(saved.status)) throw new LostLeaseError();
    await this.flush(owner);
    return { ...value, alert };
  }
  async flush(owner?: string) {
    for (const record of await this.db.scan<Occurrence>("monitor-occurrences")) {
      if (record.value.published || (owner && owner !== record.owner)) continue;
      const value = record.value;
      await this.notify(record.owner, value.title, value.body, value.taskId, value.id);
      await this.db.compareAndSwap(
        record.owner,
        "monitor-occurrences",
        value.id,
        { published: false },
        { published: true },
      );
    }
  }
}
