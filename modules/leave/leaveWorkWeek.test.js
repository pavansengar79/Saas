"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { daysInYear } = require("./leaveAccounting");

const SIX = ["MON", "TUE", "WED", "THU", "FRI", "SAT"];

test("L-04: cross-year leave split counts Saturday for a 6-day company", () => {
  // Thu 31 Dec 2026 – Sat 2 Jan 2027 → working days Thu, Fri, Sat = 3 (6-day week)
  const req = { startDate: "2026-12-31", endDate: "2027-01-02", totalDays: 3 };
  assert.equal(daysInYear(req, 2026, SIX), 1);
  assert.equal(daysInYear(req, 2027, SIX), 2);
});

test("L-04: default stays Mon–Fri when company has no workWeek", () => {
  // Thu 31 Dec – Sat 2 Jan, Mon–Fri → Thu, Fri = 2
  const req = { startDate: "2026-12-31", endDate: "2027-01-02", totalDays: 2 };
  assert.equal(daysInYear(req, 2026), 1);
  assert.equal(daysInYear(req, 2027), 1);
});
