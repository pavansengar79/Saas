"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const validation = require("./attendance.validation");

test("AT-06 My Attendance accepts a status filter", () => {
  const { error } = validation.getMyAttendance.validate({ month: "2026-10", status: "LATE" });
  assert.equal(error, undefined);
  assert.ok(validation.getMyAttendance.validate({ month: "2026-10", status: "NONSENSE" }).error);
});

test("AT-07 regularization with only a check-out time is valid", () => {
  const base = { regularizationType: "MISSED_PUNCH_OUT", status: "PRESENT", remarks: "Forgot to punch out" };
  assert.equal(validation.regularize.validate({ ...base, checkOut: "2026-10-15T14:30:00.000Z" }).error, undefined);
  const backwards = validation.regularize.validate({
    ...base, regularizationType: "WRONG_TIME", checkIn: "2026-10-15T15:30:00.000Z", checkOut: "2026-10-15T14:30:00.000Z",
  });
  assert.match(backwards.error.message, /Check-out must be after check-in/);
});
