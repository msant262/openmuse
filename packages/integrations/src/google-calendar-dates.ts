const civilDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const dateTimePattern =
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const dayMs = 24 * 60 * 60 * 1000;

export function isCalendarCivilDate(value: string): boolean {
  const match = civilDatePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthDays[month - 1];
}

export function assertCalendarCivilDate(value: string, field = "Calendar date"): void {
  if (!isCalendarCivilDate(value))
    throw new Error(`${field} must be a valid YYYY-MM-DD civil date`);
}

export function parseCalendarInstant(value: string): number {
  const match = dateTimePattern.exec(value);
  if (!match || !isCalendarCivilDate(match[1]))
    throw new Error("Calendar date-time must be a valid RFC 3339 date-time with an offset");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error("Calendar date-time must be a valid RFC 3339 date-time with an offset");
  return timestamp;
}

export function assertCalendarRange(start: string, end: string, allDay: boolean): void {
  if (allDay) {
    assertCalendarCivilDate(start, "Calendar all-day start");
    assertCalendarCivilDate(end, "Calendar all-day end");
    if (end <= start) throw new Error("Calendar all-day end must be after its start date");
    return;
  }
  if (parseCalendarInstant(end) <= parseCalendarInstant(start))
    throw new Error("Calendar event end must be after its start");
}

export function isCalendarTimeZone(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function calendarTimeZone(value?: string, fallback = "UTC"): string {
  if (isCalendarTimeZone(value)) return value;
  if (isCalendarTimeZone(fallback)) return fallback;
  return "UTC";
}

function localDatePartsFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function localCivilDate(epochMs: number, formatter: Intl.DateTimeFormat): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochMs)).map(({ type, value }) => [type, value]),
  );
  return `${parts.year.padStart(4, "0")}-${parts.month.padStart(2, "0")}-${parts.day.padStart(2, "0")}`;
}

export function calendarCivilDateAt(epochMs: number, timeZone: string): string {
  const formatter = localDatePartsFormatter(calendarTimeZone(timeZone));
  return localCivilDate(epochMs, formatter);
}

export function addCalendarCivilDays(value: string, days: number): string {
  assertCalendarCivilDate(value);
  if (!Number.isInteger(days)) throw new Error("Calendar day offset must be an integer");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day + days);
  const shifted = date.toISOString().slice(0, 10);
  assertCalendarCivilDate(shifted);
  return shifted;
}

/** Resolve local midnight, advancing to the first valid instant when DST skips midnight. */
export function calendarCivilDayStart(value: string, timeZone: string): string {
  assertCalendarCivilDate(value);
  if (!isCalendarTimeZone(timeZone)) throw new Error("Calendar time zone is missing or invalid");
  const [year, month, day] = value.split("-").map(Number);
  const midnight = new Date(0);
  midnight.setUTCHours(0, 0, 0, 0);
  midnight.setUTCFullYear(year, month - 1, day);
  const localMidnightAsUtc = midnight.getTime();
  const formatter = localDatePartsFormatter(timeZone);
  const searchStart = localMidnightAsUtc - 16 * 60 * 60 * 1000;
  const searchEnd = localMidnightAsUtc + 16 * 60 * 60 * 1000;
  const step = 60 * 60 * 1000;

  for (let candidate = searchStart; candidate <= searchEnd; candidate += step) {
    if (localCivilDate(candidate, formatter) !== value) continue;
    let low = candidate - step;
    let high = candidate;
    while (high - low > 1000) {
      const middle = Math.floor((low + high) / 2000) * 1000;
      if (middle <= low || middle >= high) break;
      if (localCivilDate(middle, formatter) === value) high = middle;
      else low = middle;
    }
    return new Date(high).toISOString();
  }

  throw new Error(`Calendar civil date ${value} does not exist in ${timeZone}`);
}

export function calendarQueryBound(value: string, timeZone: string, field: string): string {
  if (isCalendarCivilDate(value)) return calendarCivilDayStart(value, timeZone);
  try {
    parseCalendarInstant(value);
    return value;
  } catch {
    throw new Error(
      `Invalid ${field}: use a valid civil date or an RFC 3339 date-time with offset`,
    );
  }
}

export function calendarDefaultWindow(timeZone: string, now = Date.now()): [string, string] {
  const today = calendarCivilDateAt(now, timeZone);
  return [
    calendarCivilDayStart(today, timeZone),
    calendarCivilDayStart(addCalendarCivilDays(today, 31), timeZone),
  ];
}

export const CALENDAR_DAY_MS = dayMs;
