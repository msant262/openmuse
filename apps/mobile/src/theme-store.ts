export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const THEME_KEY = "okamibot.ui-theme.v1";
const isMode = (value: unknown): value is ThemeMode =>
  ["system", "light", "dark"].includes(String(value));
export function resolveTheme(mode: ThemeMode, system: string | null | undefined): ResolvedTheme {
  return mode === "system" ? (system === "dark" ? "dark" : "light") : mode;
}

export class ThemeStore {
  private mode: ThemeMode = "system";
  private revision = 0;
  private restored?: Promise<void>;
  private pending = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(
    private readonly storage: {
      read(key: string): Promise<string | null>;
      write(key: string, value: string): Promise<void>;
    },
  ) {}
  get = () => this.mode;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(mode: ThemeMode) {
    this.mode = mode;
    for (const listener of this.listeners) listener();
  }
  restore() {
    if (!this.restored) {
      const revision = this.revision;
      this.restored = this.storage
        .read(THEME_KEY)
        .then((saved) => {
          if (revision === this.revision && isMode(saved)) this.publish(saved);
        })
        .catch(() => {});
    }
    return this.restored;
  }
  set = (mode: ThemeMode): Promise<void> => {
    if (!isMode(mode)) return Promise.reject(new Error("Unsupported theme"));
    const revision = ++this.revision;
    const pending = this.pending
      .catch(() => {})
      .then(async () => {
        await this.storage.write(THEME_KEY, mode);
        if (this.revision === revision) this.publish(mode);
      });
    this.pending = pending;
    return pending;
  };
}
