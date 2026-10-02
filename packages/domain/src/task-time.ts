import { z } from "zod";

/** A local wall time needs its user's zone. DST gaps/repeated hours need an
 * explicit offset; silently choosing an instant changes the requested deadline. */
export function taskInstant(value: string, timezone = "Europe/Berlin"): string {
  if (z.iso.datetime({ offset: true }).safeParse(value).success)
    return new Date(value).toISOString();
  const local =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim()) ??
    (() => {
      const input = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value.trim());
      return input ? [input[0], input[3], input[2], input[1], input[4], input[5]] : null;
    })();
  if (
    !local ||
    !z.iso.date().safeParse(`${local[1]}-${local[2]}-${local[3]}`).success ||
    Number(local[4]) > 23 ||
    Number(local[5]) > 59
  )
    throw new Error("Enter a valid date and time: DD/MM/YYYY HH:mm");
  const expected = [local[1], local[2], local[3], local[4], local[5]].join("-");
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const center = Date.UTC(
    Number(local[1]),
    Number(local[2]) - 1,
    Number(local[3]),
    Number(local[4]),
    Number(local[5]),
  );
  const matches: number[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const instant = center + offset * 60_000;
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    if ([parts.year, parts.month, parts.day, parts.hour, parts.minute].join("-") === expected)
      matches.push(instant);
  }
  if (!matches.length)
    throw new Error("This local time does not exist when the clocks change. Choose another time.");
  if (matches.length > 1)
    throw new Error(
      "This local time occurs twice when the clocks change. Specify an explicit UTC offset.",
    );
  return new Date(matches[0]).toISOString();
}
