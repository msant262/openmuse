import assert from "node:assert/strict";
import { test } from "node:test";
import { cronDayTime, dayTimeCron } from "../src/routine-schedule.ts";

test("day/time routine builder saves weekday8AM and reads schedules back", () => {
  assert.equal(dayTimeCron([1, 2, 3, 4, 5], "08:00"), "0 8 * * 1,2,3,4,5");
  assert.deepEqual(cronDayTime("0 8 * * 1-5"), { days: [1, 2, 3, 4, 5], time: "08:00" });
  assert.throws(() => dayTimeCron([], "08:00"));
  assert.throws(() => dayTimeCron([1], "24:00"));
});
