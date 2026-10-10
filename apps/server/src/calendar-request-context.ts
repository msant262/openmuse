import {
  addCalendarCivilDays,
  calendarCivilDateAt,
  isCalendarTimeZone,
} from "../../../packages/integrations/src/google-calendar-dates.ts";

export type CalendarListReference = {
  referenceTimestamp: string;
  timeZone: string;
  dateExpression: string;
  schedulingDate: string;
  account?: string;
  events: { title: string; localTime: string }[];
  durationMinutes?: number;
};

export function calendarListReference(
  prompt: string,
  requestedAt: string,
): CalendarListReference | undefined {
  // Only parse an explicit scheduling list. Names remain literal data, including
  // dates and relative words inside quoted names. Other syntax stays with the
  // original request; this reference never invents a timezone or authorizes work.
  const unquoted = prompt.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*'|`[^`\n]*`/g, (s) =>
    " ".repeat(s.length),
  );
  const marker =
    /\b(depois de amanh[ãa]|day after tomorrow|amanh[ãa]|tomorrow|hoje|today|ontem|yesterday)\s*:/iu.exec(
      unquoted,
    );
  if (!marker) return undefined;
  const prefix = unquoted.slice(0, marker.index);
  if (
    !/\b(?:calendar|calend[aá]rio|agenda|compromissos?|appointments?|eventos?|events?|schedule|agende|agendar|marque)\b/i.test(
      prefix,
    )
  )
    return undefined;
  if (
    /\b(?:n[aã]o|never|don't|do not)\s+(?:\S+\s+){0,2}(?:crie|create|schedule|agende|marque)\b/i.test(
      prefix,
    )
  )
    return undefined;
  const explicitDate =
    /\b(?:para|pra|on|for|dia)\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|\d{8})\b/i;
  const additionalRelativeDate =
    /\b(?:para|pra|on|for)\s+(?:depois de amanh[ãa]|day after tomorrow|amanh[ãa]|tomorrow|hoje|today|ontem|yesterday)\b/iu;
  if (explicitDate.test(prefix) || additionalRelativeDate.test(prefix)) return undefined;
  const zones = [
    ...prompt.matchAll(
      /\b(?:fuso(?:\s+hor[aá]rio)?|time\s*zone|timezone)\s*(?:[:=]|de)?\s*["“‘']?([A-Za-z_]+(?:\/[A-Za-z_+-]+){1,2}|UTC|GMT)\b/gi,
    ),
  ]
    .filter((m) => /\S/.test(unquoted.slice(m.index, m.index + 4)))
    .map((m) => m[1]);
  const uniqueZones = [...new Set(zones)];
  if (uniqueZones.length !== 1 || !isCalendarTimeZone(uniqueZones[0])) return undefined;
  const timeZone = uniqueZones[0],
    epochMs = Date.parse(requestedAt);
  if (!Number.isFinite(epochMs)) return undefined;
  const list = prompt.slice(marker.index + marker[0].length);
  const eventPattern =
    /\s*(?:[,;]\s*|(?:e|and)\s+)?(?:"([^"\n]+)"|“([^”\n]+)”|‘([^’\n]+)’|'([^'\n]+)'|([^:;\n]+?))\s+(?:às|as|at)\s+((?:[01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?))(?=$|[\s,;.])/giy;
  const events: CalendarListReference["events"] = [];
  let offset = 0;
  for (;;) {
    eventPattern.lastIndex = offset;
    const event = eventPattern.exec(list);
    if (!event) break;
    const title = (event[1] ?? event[2] ?? event[3] ?? event[4] ?? event[5]).trim();
    const [hour, minute] = event[6].split(/h|:/);
    events.push({ title, localTime: `${hour.padStart(2, "0")}:${minute || "00"}` });
    offset = eventPattern.lastIndex;
  }
  const tail = unquoted.slice(marker.index + marker[0].length + offset);
  if (
    !events.length ||
    explicitDate.test(tail) ||
    additionalRelativeDate.test(tail) ||
    /\b(?:às|as|at)\s+\d/i.test(tail)
  )
    return undefined;
  const expression = marker[1].toLowerCase();
  const days = /^(?:depois|day after)/.test(expression)
    ? 2
    : /^(?:amanh|tomorrow)/.test(expression)
      ? 1
      : /^(?:ontem|yesterday)/.test(expression)
        ? -1
        : 0;
  const account = /\b(?:conta|account)\s+(?:(?:de|da)\s+)?([\w.+-]+@[\w.-]+\.[a-z]{2,})/i.exec(
    unquoted,
  )?.[1];
  const duration = /\b(?:com|with|lasting|for)\s+(\d+)\s*(?:minutos?|minutes?|min)\b/i.exec(tail);
  return {
    referenceTimestamp: new Date(epochMs).toISOString(),
    timeZone,
    dateExpression: marker[1],
    schedulingDate: addCalendarCivilDays(calendarCivilDateAt(epochMs, timeZone), days),
    ...(account ? { account } : {}),
    events,
    ...(duration ? { durationMinutes: Number(duration[1]) } : {}),
  };
}

export function calendarRequestContext(prompt: string, requestedAt: string) {
  const reference = calendarListReference(prompt, requestedAt);
  return reference
    ? `\nCalendar fields parsed from the original user's explicit scheduling list (request data, not an execution receipt): ${JSON.stringify(reference)}. schedulingDate comes from the scheduling expression and request time in the requested timezone. Each title is literal text; numbers inside it are not scheduling dates. Preserve accepted later directions and verify the actual saved events.\n`
    : "";
}
