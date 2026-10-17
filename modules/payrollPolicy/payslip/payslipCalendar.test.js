"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPayslipCalendar } = require("./payslipCalendar");

const date = day => new Date(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`);

test("calendar respects saved UTC cutoff and reconciles recurring credit and LOP cents", () => {
  const payslip = {
    year: 2026, month: 10, calculatedThrough: new Date("2026-10-16T23:59:59.999Z"),
    earnings: { basic: 12000, hra: 2400, bonus: 500 },
    grossSalary: 14900, deductions: { lop: 1200, pf: 300 }, netSalary: 13400,
  };
  const calendar = buildPayslipCalendar({
    payslip, timezone: "Asia/Kolkata", workWeek: ["MON", "TUE", "WED", "THU", "FRI"],
    attendance: [{ date: date(1), status: "PRESENT" }, { date: date(5), status: "HALF_DAY" },
      { date: date(6), status: "ON_LEAVE", isLWP: true }],
    holidays: [{ date: date(2), name: "Gandhi Jayanti" }, { date: date(9), name: "Dussehra" }],
    leaves: [{ startDate: date(6), endDate: date(6), leaveTypeId: "unpaid" },
      { startDate: date(7), endDate: date(7), leaveTypeId: "paid" }],
    paidLeaveTypeIds: new Set(["paid"]),
  });
  const byDate = day => calendar.days.find(entry => entry.date === `2026-10-${day}`);
  assert.equal(calendar.days.length, 16);
  assert.equal(calendar.calculatedThrough, "2026-10-16");
  assert.equal(byDate("02").status, "HOLIDAY");
  assert.equal(byDate("02").payable, 1);
  assert.equal(byDate("03").status, "OFF");
  assert.equal(byDate("03").payable, 0);
  assert.equal(byDate("03").credit, 900);
  assert.equal(byDate("04").credit, 900);
  assert.equal(byDate("03").debit, 0);
  assert.equal(byDate("05").payable, 0.5);
  assert.equal(byDate("05").unpaid, 0.5);
  assert.equal(byDate("06").status, "UNPAID_LEAVE");
  assert.equal(byDate("07").status, "PAID_LEAVE");
  assert.equal(calendar.days.reduce((sum, day) => sum + Math.round(day.credit * 100), 0), 1440000);
  assert.equal(calendar.days.reduce((sum, day) => sum + Math.round(day.debit * 100), 0), 120000);
  assert.equal(calendar.monthlyEarnings, 500);
  assert.deepEqual(calendar.monthlyDeductions, [{ label: "pf", amount: 300 }]);
});

test("calendar excludes pre-joining and future days without inventing earnings", () => {
  const calendar = buildPayslipCalendar({
    payslip: { year: 2026, month: 10, calculatedThrough: date(5), earnings: { basic: 100 }, grossSalary: 100 },
    attendance: [], holidays: [], leaves: [], paidLeaveTypeIds: new Set(),
    timezone: "Asia/Kolkata", joiningDate: date(3), workWeek: ["MON", "TUE", "WED", "THU", "FRI"],
  });
  assert.equal(calendar.days.length, 5);
  assert.equal(calendar.days[0].status, "NOT_ELIGIBLE");
  assert.equal(calendar.days[0].credit, 0);
  assert.equal(calendar.days[2].status, "OFF");
  assert.equal(calendar.days[2].credit, 33.33);
  assert.equal(calendar.days[4].status, "ABSENT");
  assert.equal(calendar.days[4].credit, 33.33);
  assert.equal(calendar.days.reduce((sum, day) => sum + Math.round(day.credit * 100), 0), 10000);
});

test("saved LOP stays monthly when current unpaid days do not match the payslip", () => {
  const calendar = buildPayslipCalendar({
    payslip: { year: 2026, month: 10, calculatedThrough: date(6), lopDays: 1,
      earnings: { basic: 600 }, grossSalary: 600, deductions: { lop: 100, pf: 10 } },
    attendance: [{ date: date(5), status: "PRESENT" }, { date: date(6), status: "HALF_DAY" }],
    holidays: [{ date: date(2), name: "Gandhi Jayanti" }], leaves: [], paidLeaveTypeIds: new Set(),
    timezone: "Asia/Kolkata", workWeek: ["MON", "TUE", "WED", "THU", "FRI"],
  });
  assert.equal(calendar.days.find(day => day.date === "2026-10-01").unpaid, 1);
  assert.equal(calendar.days.find(day => day.date === "2026-10-06").unpaid, 0.5);
  assert.equal(calendar.days.reduce((sum, day) => sum + day.debit, 0), 0);
  assert.deepEqual(calendar.monthlyDeductions, [
    { label: "pf", amount: 10 },
    { label: "LOP (saved payslip; daily records differ)", amount: 100 },
  ]);
});

test("a worked half-day plus paid half-leave receives one day credit", () => {
  const calendar = buildPayslipCalendar({
    payslip: { year: 2026, month: 10, calculatedThrough: date(5), earnings: { basic: 100 }, grossSalary: 100 },
    attendance: [{ date: date(5), status: "HALF_DAY" }], holidays: [],
    leaves: [{ startDate: date(5), endDate: date(5), isHalfDay: true, leaveTypeId: "paid" }],
    paidLeaveTypeIds: new Set(["paid"]), timezone: "Asia/Kolkata",
    workWeek: ["MON", "TUE", "WED", "THU", "FRI"],
  });
  assert.equal(calendar.days[4].payable, 1);
  assert.equal(calendar.days[4].unpaid, 0);
});

test("holiday attendance stays payable without a holiday master entry", () => {
  const calendar = buildPayslipCalendar({
    payslip: { year: 2026, month: 10, calculatedThrough: date(2), earnings: { basic: 100 }, grossSalary: 100 },
    attendance: [{ date: date(2), status: "HOLIDAY" }], holidays: [], leaves: [],
    paidLeaveTypeIds: new Set(), timezone: "Asia/Kolkata", workWeek: ["MON", "TUE", "WED", "THU", "FRI"],
  });
  assert.equal(calendar.days[1].status, "HOLIDAY");
  assert.equal(calendar.days[1].payable, 1);
});