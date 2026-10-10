import type { CDPSession, Page } from "playwright";
import type { z } from "zod";
import type {
  browserCdpInputSchema,
  browserConsoleInputSchema,
} from "../../../packages/domain/src/browser-diagnostics.ts";
import { WorkerError } from "./errors.ts";

type Entry = {
  sequence: number;
  source: "console" | "exception";
  level: string;
  text: string;
  recordedAt: string;
  truncated: boolean;
};
/** Bounded per-page diagnostics; no polling, JS-handle retention or disk log. */
export class BrowserDiagnostics {
  private entries: Entry[] = [];
  private sequence = 0;
  private bytes = 0;
  private dropped = 0;
  private cdpSession?: Promise<CDPSession>;
  private secrets = new Set<string>();
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
    page.on("console", (message) => this.append("console", message.type(), message.text()));
    page.on("pageerror", (error) => this.append("exception", "error", error.message));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.clear();
    });
  }
  protectSecrets(values: string[]) {
    const merged = new Set([...this.secrets, ...values.filter(Boolean)]);
    if ([...merged].reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > 1024 * 1024)
      throw new WorkerError(
        "CREDENTIAL_REDACTION_CAPACITY",
        "Reopen this browser profile before entering more protected credentials.",
        409,
      );
    this.secrets = merged;
    // Already captured messages are redacted again when read. Credential
    // adapters call this before typing, and secrets never enter durable logs.
  }
  redact(text: string) {
    for (const value of this.secrets) text = text.split(value).join("[redacted]");
    return text.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");
  }
  private append(source: Entry["source"], level: string, raw: string) {
    const text = this.redact(raw),
      bounded = text.slice(0, 8192);
    this.entries.push({
      sequence: ++this.sequence,
      source,
      level: level.slice(0, 40),
      text: bounded,
      recordedAt: new Date().toISOString(),
      truncated: text.length > bounded.length,
    });
    this.bytes += Buffer.byteLength(bounded);
    while (this.entries.length > 1000 || this.bytes > 2 * 1024 * 1024) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.bytes -= Buffer.byteLength(removed.text);
      this.dropped++;
    }
  }
  console(input: z.output<typeof browserConsoleInputSchema>) {
    const available = this.entries.filter((entry) => entry.sequence > input.after);
    const entries = available
      .slice(0, input.limit)
      .map((entry) => ({ ...entry, text: this.redact(entry.text) }));
    const nextAfter = available.length > entries.length ? (entries.at(-1)?.sequence ?? null) : null;
    const dropped = this.dropped;
    if (input.clear) this.clear();
    return { entries, nextAfter, dropped, cleared: input.clear };
  }
  private clear() {
    this.entries = [];
    this.bytes = 0;
    this.dropped = 0;
  }
  async cdp(input: z.output<typeof browserCdpInputSchema>) {
    this.cdpSession ??= this.page.context().newCDPSession(this.page);
    const session = await this.cdpSession.catch((error) => {
      this.cdpSession = undefined;
      throw error;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;
    try {
      result = await Promise.race([
        session.send(input.method as never, input.params as never),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new WorkerError(
                  "BROWSER_DIAGNOSTIC_TIMEOUT",
                  "The read-only protocol command did not answer within ten seconds. Obtain a fresh page snapshot.",
                  504,
                ),
              ),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) > 1024 * 1024)
      throw new WorkerError(
        "BROWSER_DIAGNOSTIC_TOO_LARGE",
        "The protocol result exceeds one megabyte. Query a smaller DOM subtree.",
        413,
      );
    // Redact values recursively rather than replacing serialized JSON, which
    // can corrupt keys or quoting and turn legitimate results into failures.
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") return this.redact(value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    return redact(result) as Record<string, unknown>;
  }
}
