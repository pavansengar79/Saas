"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const employeeId = new mongoose.Types.ObjectId();
const companyId = new mongoose.Types.ObjectId();
const unitId = new mongoose.Types.ObjectId();
const organizationId = new mongoose.Types.ObjectId();
const employee = {
  _id: employeeId,
  org_id: organizationId,
  company_id: companyId,
  unit_id: unitId,
  name: "Murali",
  joiningDate: new Date("2026-10-06T00:00:00.000Z"),
  salary: { basic: 15000, hra: 1200, travelAllowance: 120 },
};
const policy = {
  salaryCycle: { startDay: 1, endDay: 13, payrollRunDate: 1, workingDaysCalc: "fixed", fixedWorkingDays: 30 },
  lop: { perDayFormula: "monthly_salary/30" },
  taxCompliance: { pfEnabled: true, pfEmployeeRate: 12, esiEnabled: true, esiEmployeeRate: 0.75 },
  tdsConfig: { enabled: false },
};

const stub = (modulePath, exports) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const query = value => ({ select() { return this; }, async lean() { return value; } });
let attendanceMatch;
let attendanceGroup;
let attendanceTotals = { present: 5, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };

stub("./payrollLock.service", { isPeriodLocked: async () => true });
stub("../../utils/policyResolver", {
  resolveAttendancePolicy: async () => ({ overtime: { enabled: false } }),
  resolvePayrollPolicy: async () => policy,
});
stub("../employee/models/employee.model", { findOne: async () => employee });
stub("../attendance/models/attendance.model", {
  aggregate: async pipeline => {
    attendanceMatch = pipeline[0].$match;
    attendanceGroup = pipeline[1].$group;
    return [attendanceTotals];
  },
});
stub("../companyConfig/models/companyConfig.model", {
  findOne: () => query({ workWeek: ["MON", "TUE", "WED", "THU", "FRI"] }),
});
stub("../company/models/company.model", { findOne: () => query({}) });
stub("../unit/models/unit.model", { findOne: () => query({}) });
stub("./models/payslip.model", {
  findOne: () => query(null),
  find: () => query([]),
  findOneAndUpdate: async (filter, update) => update,
});
const rules = require("./payrollRunRules");
stub("./payrollRunRules", { ...rules, assertPayrollRunDateReached: () => {} });

const { runForEmployee } = require("./payrollRun.service");

test("1-13 October cycle pays only recorded days after joining, without future LOP", async () => {
  const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });

  assert.equal(attendanceMatch.date.$gte.toISOString(), "2026-10-05T18:30:00.000Z");
  assert.equal(attendanceMatch.date.$lte.toISOString(), "2026-10-13T18:29:59.999Z");
  assert.equal(attendanceGroup.present.$sum.$cond[0].$and[0].$in[0].$dayOfWeek.timezone, "Asia/Kolkata");
  assert.equal(attendanceMatch.$expr, undefined);
  assert.equal(payslip.totalWorkingDays, 9);
  assert.equal(payslip.actualPayableDays, 13);
  assert.equal(payslip.eligibleCalendarDays, 8);
  assert.equal(payslip.eligibleWorkingDays, 6);
  assert.equal(payslip.daysPresent, 5);
  assert.equal(payslip.lopDays, 1);
  assert.equal(payslip.daysPayable, 5);
  assert.equal(payslip.earnings.basic, 3000);
  assert.equal(payslip.earnings.hra, 240);
  assert.equal(payslip.earnings.travelAllowance, 24);
  assert.equal(payslip.grossSalary, 3264);
  assert.equal(payslip.lopPerDayRate, 544);
  assert.equal(payslip.deductions.lop, 544);
  assert.equal(payslip.deductions.pf, 300);
  assert.equal(payslip.deductions.esi, 20.4);
  assert.equal(payslip.grossAfterLOP, 2720);
  assert.equal(payslip.netSalary, 2399.6);
});

test("disabled LOP pays five attended workdays without an LOP deduction", async () => {
  policy.lop.enabled = false;
  attendanceTotals = { present: 4, halfDay: 0, weekendWorked: 1, onLeave: 0, holiday: 0, overtimeHours: 0 };
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });

    assert.equal(payslip.eligibleWorkingDays, 6);
    assert.equal(payslip.daysPayable, 5);
    assert.equal(payslip.lopDays, 0);
    assert.equal(payslip.deductions.lop, 0);
    assert.equal(payslip.earnings.basic, 2500);
    assert.equal(payslip.grossSalary, 2720);
    assert.equal(payslip.grossAfterLOP, 2720);
  } finally {
    delete policy.lop.enabled;
    attendanceTotals = { present: 5, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  }
});

test("worked weekend is payable but missing weekdays count toward enabled LOP", async () => {
  attendanceTotals = { present: 4, halfDay: 0, weekendWorked: 1, onLeave: 0, holiday: 0, overtimeHours: 0 };
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    assert.equal(payslip.daysPresent, 5);
    assert.equal(payslip.daysPayable, 5);
    assert.equal(payslip.lopDays, 2);
    assert.equal(payslip.earnings.basic, 3500);
    assert.equal(payslip.deductions.lop, 1088);
  } finally {
    attendanceTotals = { present: 5, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  }
});