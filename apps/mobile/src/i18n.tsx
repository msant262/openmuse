import { useCallback, useEffect, useSyncExternalStore } from "react";
import { ptBR } from "./i18n-catalog";
import { LocaleStore, translate } from "./i18n-core";
import { messageStorage } from "./message-storage";

export type { Locale } from "./i18n-core";

const localeStore = new LocaleStore(messageStorage);
export function t(key: string, values?: Record<string, string | number>) {
  return translate(localeStore.get(), ptBR, key, values);
}
export function useI18n() {
  const locale = useSyncExternalStore(localeStore.subscribe, localeStore.get, () => "en" as const);
  useEffect(() => {
    void localeStore.restore();
  }, []);
  const translateCurrent = useCallback(
    (key: string, values?: Record<string, string | number>) => translate(locale, ptBR, key, values),
    [locale],
  );
  return { locale, setLocale: localeStore.set, t: translateCurrent };
}
