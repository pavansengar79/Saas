"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { resolveIsNextDay, validateShiftWindowTimezone, workWeekSet, isWorkDayIndex } = require("./timezone");

test("AT-04: end <= start is a night shift even without the flag", () => {
  assert.equal(resolveIsNextDay("16:00", "01:00", false), true);
  assert.equal(resolveIsNextDay("21:00", "05:00", undefined), true);
  assert.equal(resolveIsNextDay("09:00", "18:00", false), false);
  assert.equal(resolveIsNextDay("09:00", "18:00", true), true); // explicit flag kept
});

test("AT-04: punch at 00:30 IST falls inside the 16:00–01:00 shift", () => {
  const punch = new Date("2026-10-21T19:00:00Z"); // 22 Oct 00:30 IST
  const before = validateShiftWindowTimezone(punch, "16:00", "01:00", false, 15, "Asia/Kolkata");
  const after = validateShiftWindowTimezone(punch, "16:00", "01:00",
    resolveIsNextDay("16:00", "01:00", false), 15, "Asia/Kolkata");
  assert.equal(before.isValid, false);
  assert.equal(after.isValid, true);
});

test("AT-02: work week comes from company config", () => {
  const six = workWeekSet(["MON", "TUE", "WED", "THU", "FRI", "SAT"]);
  assert.equal(isWorkDayIndex(6, six), true);   // SAT
  assert.equal(isWorkDayIndex(0, six), false);  // SUN
  const def = workWeekSet(undefined);
  assert.equal(isWorkDayIndex(6, def), false);
  assert.equal(isWorkDayIndex(1, def), true);
});
