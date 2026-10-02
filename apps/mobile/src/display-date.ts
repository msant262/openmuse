let profileLocale = "en-US";
export function setDisplayLocale(locale: string) {
  profileLocale = Intl.getCanonicalLocales(locale)[0] ?? "en-US";
}
export function dateLabel(
  value: string,
  options?: Intl.DateTimeFormatOptions,
  locale = profileLocale,
) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(locale, options ?? { month: "short", day: "numeric" });
}
export function timeLabel(value: string, timeZone?: string, locale = profileLocale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone });
}
export function relativeDate(value: string, now = Date.now(), locale = profileLocale) {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return value;
  const diff = instant - now;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(diff) < 60_000) return formatter.format(Math.round(diff / 1000), "second");
  if (Math.abs(diff) < 3600_000) return formatter.format(Math.round(diff / 60_000), "minute");
  if (Math.abs(diff) < 86400_000) return formatter.format(Math.round(diff / 3600_000), "hour");
  if (diff > 0) return formatter.format(Math.round(diff / 86400_000), "day");
  return dateLabel(value, undefined, locale);
}
