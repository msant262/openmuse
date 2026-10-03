export type Locale = "en" | "pt-BR";
export const LOCALE_KEY = "okamibot.ui-locale.v1";
export const isLocale = (value: unknown): value is Locale => value === "en" || value === "pt-BR";

export class LocaleStore {
  private locale: Locale = "en";
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
  get = () => this.locale;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(locale: Locale) {
    this.locale = locale;
    for (const listener of this.listeners) listener();
  }
  restore() {
    if (!this.restored) {
      const revision = this.revision;
      this.restored = this.storage
        .read(LOCALE_KEY)
        .then((saved) => {
          if (this.revision === revision && isLocale(saved)) this.publish(saved);
        })
        .catch(() => {});
    }
    return this.restored;
  }
  set = (locale: Locale): Promise<void> => {
    if (!isLocale(locale)) return Promise.reject(new Error("Unsupported app language"));
    const revision = ++this.revision;
    const pending = this.pending
      .catch(() => {})
      .then(async () => {
        await this.storage.write(LOCALE_KEY, locale);
        if (this.revision === revision) this.publish(locale);
      });
    this.pending = pending;
    return pending;
  };
}

export function translate(
  locale: Locale,
  catalog: Record<string, string>,
  key: string,
  values: Record<string, string | number> = {},
): string {
  return (locale === "pt-BR" ? (catalog[key] ?? key) : key).replace(
    /\{([\w]+)\}/g,
    (match, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : match),
  );
}
