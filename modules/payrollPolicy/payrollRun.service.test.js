"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const employeeId = new mongoose.Types.ObjectId();
const companyId = new mongoose.Types.ObjectId();
const unitId = new mongoose.Types.ObjectId();
const organizationId = new mongoose.Types.ObjectId();
const leaveTypeId = new mongoose.Types.ObjectId();
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
let approvedLeaves = [];
let attendanceOnLeaveDays = [];
let paidLeaveTypes = [{ _id: leaveTypeId, isPaid: true }];
let payrollPolicyOptions;

stub("./payrollLock.service", { isPeriodLocked: async () => true });
stub("../../utils/policyResolver", {
  resolveAttendancePolicy: async () => ({ overtime: { enabled: false } }),
  resolvePayrollPolicy: async (_employeeId, _companyId, _unitId, options) => {
    payrollPolicyOptions = options;
    return policy;
  },
});
stub("./models/investmentDeclaration.model", { findOne: () => query(null) });
stub("../employee/models/employee.model", { findOne: async () => employee });
stub("../attendance/models/attendance.model", {
  aggregate: async pipeline => {
    attendanceMatch = pipeline[0].$match;
    attendanceGroup = pipeline[1].$group;
    return [attendanceTotals];
  },
  find: () => query(attendanceOnLeaveDays),
});
stub("../leave/models/leaveRequest.models", { find: () => query(approvedLeaves) });
stub("../leave/models/leaveType.models", { find: () => query(paidLeaveTypes) });
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

test("disabled LOP keeps eligible salary despite missed attendance", async () => {
  policy.lop.enabled = false;
  attendanceTotals = { present: 4, halfDay: 0, weekendWorked: 1, onLeave: 0, holiday: 0, overtimeHours: 0 };
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });

    assert.equal(payslip.eligibleWorkingDays, 6);
    assert.equal(payslip.daysPayable, 5);
    assert.equal(payslip.lopDays, 0);
    assert.equal(payslip.deductions.lop, 0);
    assert.equal(payslip.earnings.basic, 3500);
    assert.equal(payslip.grossSalary, 3808);
    assert.equal(payslip.grossAfterLOP, 3808);
  } finally {
    delete policy.lop.enabled;
    attendanceTotals = { present: 5, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  }
});

test("approved paid leave without an attendance row does not become LOP", async () => {
  approvedLeaves = [{ startDate: new Date("2026-10-07T00:00:00Z"), endDate: new Date("2026-10-07T00:00:00Z"), leaveTypeId, isHalfDay: false }];
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    assert.equal(payslip.daysPresent, 6);
    assert.equal(payslip.lopDays, 0);
    assert.equal(payslip.deductions.lop, 0);
  } finally {
    approvedLeaves = [];
  }
});

test("approved paid leave on an absent attendance row is credited once", async () => {
  approvedLeaves = [{ startDate: new Date("2026-10-07T00:00:00Z"), endDate: new Date("2026-10-07T00:00:00Z"), leaveTypeId }];
  attendanceOnLeaveDays = [{ date: new Date("2026-10-07T00:00:00Z"), status: "ABSENT" }];
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    assert.equal(payslip.lopDays, 0);
  } finally {
    approvedLeaves = [];
    attendanceOnLeaveDays = [];
  }
});

test("half-day approved paid leave credits only half a day", async () => {
  approvedLeaves = [{ startDate: new Date("2026-10-07T00:00:00Z"), endDate: new Date("2026-10-07T00:00:00Z"), leaveTypeId, isHalfDay: true }];
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    assert.equal(payslip.daysPresent, 5.5);
    assert.equal(payslip.lopDays, 0.5);
  } finally {
    approvedLeaves = [];
  }
});

test("already counted leave attendance cannot be credited twice", async () => {
  approvedLeaves = [{ startDate: new Date("2026-10-07T00:00:00Z"), endDate: new Date("2026-10-07T00:00:00Z"), leaveTypeId }];
  attendanceOnLeaveDays = [{ date: new Date("2026-10-07T00:00:00Z"), status: "ON_LEAVE" }];
  attendanceTotals = { present: 5, halfDay: 0, onLeave: 1, holiday: 0, overtimeHours: 0 };
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    assert.equal(payslip.daysPresent, 6);
    assert.equal(payslip.lopDays, 0);
  } finally {
    approvedLeaves = [];
    attendanceOnLeaveDays = [];
    attendanceTotals = { present: 5, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  }
});

test("approved unpaid leave cannot earn paid day credit", async () => {
  approvedLeaves = [{ startDate: new Date("2026-10-07T00:00:00Z"), endDate: new Date("2026-10-07T00:00:00Z"), leaveTypeId }];
  paidLeaveTypes = [];
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    assert.equal(payslip.lopDays, 1);
    assert.equal(payslip.deductions.lop, 544);
  } finally {
    approvedLeaves = [];
    paidLeaveTypes = [{ _id: leaveTypeId, isPaid: true }];
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

test("hourly LOP uses the policy hourly formula and partial-day hours", async () => {
  policy.lop.calculation = "per_hour";
  policy.lop.perDayFormula = "monthly_salary/26";
  policy.lop.perHourFormula = "monthly_salary/(working_days*standard_hours)";
  attendanceTotals = { present: 5, halfDay: 0.5, onLeave: 0, holiday: 0, overtimeHours: 0 };
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    assert.equal(payslip.lopDays, 0.5);
    assert.equal(payslip.deductions.lop, 272);
    assert.equal(payslip.lopPerDayRate, 544);
    assert.equal(payslip.lopFormulaUsed, "monthly_salary/(working_days*standard_hours)");
  } finally {
    delete policy.lop.calculation;
    policy.lop.perDayFormula = "monthly_salary/30";
    delete policy.lop.perHourFormula;
    attendanceTotals = { present: 5, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  }
});

test("hourly LOP daily-rate formula honors the configured daily divisor", async () => {
  policy.lop.calculation = "per_hour";
  policy.lop.perDayFormula = "monthly_salary/30";
  policy.lop.perHourFormula = "daily_rate/standard_hours";
  attendanceTotals = { present: 5, halfDay: 0.5, onLeave: 0, holiday: 0, overtimeHours: 0 };
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    assert.equal(payslip.deductions.lop, 272);
    assert.equal(payslip.lopPerDayRate, 544);
    assert.equal(payslip.lopFormulaUsed, "daily_rate/standard_hours");
  } finally {
    delete policy.lop.calculation;
    delete policy.lop.perHourFormula;
    attendanceTotals = { present: 5, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  }
});

test("a fully attended fixed-divisor month pays full base salary", async () => {
  const originalJoiningDate = employee.joiningDate;
  const originalEndDay = policy.salaryCycle.endDay;
  employee.joiningDate = new Date("2025-01-01T00:00:00.000Z");
  policy.salaryCycle.endDay = 31;
  attendanceTotals = { present: 22, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    assert.equal(payslip.earnings.basic, 15000);
    assert.equal(payslip.grossSalary, 16320);
    assert.equal(payslip.deductions.lop, 0);
  } finally {
    employee.joiningDate = originalJoiningDate;
    policy.salaryCycle.endDay = originalEndDay;
    attendanceTotals = { present: 5, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  }
});

test("a missing salary blocks payroll and requests a fresh policy", async () => {
  const originalSalary = employee.salary;
  employee.salary = null;
  try {
    await assert.rejects(
      runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId }),
      /no assigned salary structure/
    );
    assert.deepEqual(payrollPolicyOptions, { fresh: true });
  } finally {
    employee.salary = originalSalary;
  }
});

test("TDS projects assigned annual salary despite partial-month earnings", async () => {
  const originalSalary = employee.salary;
  employee.salary = { basic: 100000, hra: 10000 };
  policy.tdsConfig = { enabled: true, taxRegime: "new" };
  try {
    const payslip = await runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId: organizationId });
    const { calculateTDSNewRegime } = require("../../config/tdsSlabs");
    const expected = calculateTDSNewRegime(110000 * 12 - 75000);
    assert.ok(payslip.grossSalary < 110000);
    assert.equal(payslip.deductions.tds, expected.monthlyTDS);
    assert.equal(payslip.taxBreakdown.taxableIncome, expected.taxableIncome);
  } finally {
    employee.salary = originalSalary;
    policy.tdsConfig = { enabled: false };
  }
});