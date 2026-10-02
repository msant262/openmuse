import assert from "node:assert/strict";
import { test } from "node:test";
import { dateLabel, relativeDate, setDisplayLocale } from "../src/display-date.ts";

test("future dates are future relative times and use the saved profile locale", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  assert.equal(relativeDate("2026-10-03T00:00:00Z", now, "en-US"), "tomorrow");
  assert.equal(relativeDate("2026-10-02T02:00:00Z", now, "pt-BR"), "em 2 horas");
  setDisplayLocale("pt-BR");
  assert.match(dateLabel("2026-10-15T00:00:00Z"), /out/);
  assert.equal(relativeDate("broken", now), "broken");
  setDisplayLocale("en-US");
});
