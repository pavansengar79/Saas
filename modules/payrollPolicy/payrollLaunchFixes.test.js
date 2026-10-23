"use strict";

// PF-1 custom components, PF-3 finalizable flag, PF-5 exit-month TDS
const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const employeeId = new mongoose.Types.ObjectId();
const companyId = new mongoose.Types.ObjectId();
const unitId = new mongoose.Types.ObjectId();
const orgId = new mongoose.Types.ObjectId();

// Full-month employee, October 2026, 22 working days all present
const baseEmployee = () => ({
  _id: employeeId,
  org_id: orgId,
  company_id: companyId,
  unit_id: unitId,
  name: "Asha",
  joiningDate: new Date("2025-01-01T00:00:00.000Z"),
  salary: { basic: 20000, hra: 8000 },
});
let employee = baseEmployee();
let employees = [employee];
const policy = {
  salaryCycle: { startDay: 1, endDay: 31, payrollRunDate: 1 },
  lop: { perDayFormula: "monthly_salary/working_days" },
  taxCompliance: { pfEnabled: true, pfEmployeeRate: 12, pfEmployerRate: 12, esiEnabled: false },
  tdsConfig: { enabled: false },
};
let attendanceTotals = { present: 22, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
let priorPayslips = [];
let failPolicyFor = null;

const stub = (modulePath, exports) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const query = value => ({ select() { return this; }, async lean() { return value; } });

stub("./payrollLock.service", { isPeriodLocked: async () => true });
stub("../../utils/policyResolver", {
  resolveAttendancePolicy: async () => ({ overtime: { enabled: false } }),
  resolvePayrollPolicy: async (id) => {
    if (failPolicyFor && String(id) === String(failPolicyFor)) throw new Error("no policy");
    return policy;
  },
});
stub("./models/investmentDeclaration.model", { findOne: () => query(null) });
stub("../employee/models/employee.model", { findOne: async () => employee, find: () => query(employees) });
stub("../attendance/models/attendance.model", { aggregate: async () => [attendanceTotals], find: () => query([]) });
stub("../leave/models/leaveRequest.models", { find: () => query([]) });
stub("../leave/models/leaveType.models", { find: () => query([]) });
stub("../holiday/models/holiday.models", { find: () => query([]) });
stub("../companyConfig/models/companyConfig.model", {
  findOne: () => query({ timezone: "Asia/Kolkata", workWeek: ["MON", "TUE", "WED", "THU", "FRI"] }),
});
stub("../company/models/company.model", { findOne: () => query({}) });
stub("../unit/models/unit.model", { findOne: () => query({}), find: () => query([]) });
stub("./models/payslip.model", {
  findOne: () => query(null),
  find: (filter) => query(filter?.status?.$in ? [] : priorPayslips),
  findOneAndUpdate: async (filter, update) => update,
});
const rules = require("./payrollRunRules");
stub("./payrollRunRules", { ...rules, assertPayrollRunDateReached: () => {} });

const { runForEmployee, runForTenant } = require("./payrollRun.service");
const { calculateTDSNewRegime } = require("../../config/tdsSlabs");
const run = () => runForEmployee(employeeId, companyId, unitId, "2026-10", { orgId });
const reset = () => {
  employee = baseEmployee();
  employees = [employee];
  policy.tdsConfig = { enabled: false };
  policy.taxCompliance.pfApplyOnActualBasic = false;
  attendanceTotals = { present: 22, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  priorPayslips = [];
  failPolicyFor = null;
};

// ─── PF-1 rules ────────────────────────────────────────────────────────────
test("PF-1 rules: custom components are prorated and split by taxable / PF flags", () => {
  const summary = rules.summarizeCustomComponents([
    { code: "DA", name: "Dearness allowance", amount: 4000, pfApplicable: true },
    { code: "FOOD", name: "Food", amount: 2000, taxable: false },
    { code: "ZERO", name: "Unused", amount: 0 },
  ], 0.5);
  assert.equal(summary.items.length, 2);
  assert.deepEqual(summary.items[0], { code: "DA", name: "Dearness allowance", amount: 2000, taxable: true, pfApplicable: true, esiApplicable: false });
  assert.equal(summary.monthly, 6000);
  assert.equal(summary.earned, 3000);
  assert.equal(summary.monthlyNonTaxable, 2000);
  assert.equal(summary.earnedNonTaxable, 1000);
  assert.equal(summary.monthlyPf, 4000);
});

test("PF-1 rules: PF-applicable components are PF wages, capped at the ceiling", () => {
  // 12,000 basic + 3,000 DA = 15,000 PF wages → 1,800
  const small = rules.calculateStatutoryDeductions({ basic: 12000, fullBasic: 12000, customPfWages: 3000, grossSalary: 20000, year: 2026, month: 10 });
  assert.equal(small.pfEmployee, 1800);
  // 20,000 + 10,000 = 30,000 → capped at 25,000 (Oct 2026) → 3,000
  const capped = rules.calculateStatutoryDeductions({ basic: 20000, fullBasic: 20000, customPfWages: 10000, grossSalary: 40000, year: 2026, month: 10 });
  assert.equal(capped.pfEmployee, 3000);
  // Half the basic paid (LOP) → DA counted in the same share: (10,000 + 1,500) × 12%
  const actual = rules.calculateStatutoryDeductions({ basic: 10000, fullBasic: 20000, customPfWages: 3000, grossSalary: 20000, year: 2026, month: 10, taxCompliance: { pfApplyOnActualBasic: true } });
  assert.equal(actual.pfEmployee, 1380);
  // No custom PF wages → unchanged behaviour
  assert.equal(rules.calculateStatutoryDeductions({ basic: 12000, grossSalary: 20000, year: 2026, month: 10 }).pfEmployee, 1440);
});

// ─── PF-1 payroll run ──────────────────────────────────────────────────────
test("PF-1 run: custom components are in gross, earnings and PF", async () => {
  employee.salary.customComponents = [
    { code: "DA", name: "Dearness allowance", amount: 5000, pfApplicable: true },
    { code: "FOOD", name: "Food allowance", amount: 2200 },
  ];
  try {
    const payslip = await run();
    assert.equal(payslip.grossSalary, 35200);          // 20,000 + 8,000 + 5,000 + 2,200
    assert.equal(payslip.grossAfterLOP, 35200);
    assert.deepEqual(payslip.earnings.customComponents.map(c => [c.code, c.amount]), [["DA", 5000], ["FOOD", 2200]]);
    assert.equal(payslip.deductions.pf, 3000);         // (20,000 + 5,000) capped at 25,000 × 12%
    assert.equal(payslip.ytd.earnings.customComponentsTotal, 7200);
    assert.equal(payslip.netSalary, 32200);
  } finally { reset(); }
});

test("PF-1 run: LOP and mid-month proration apply to custom components too", async () => {
  employee.salary.customComponents = [{ code: "DA", name: "DA", amount: 2200 }];
  attendanceTotals = { present: 20, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  try {
    const payslip = await run();
    // monthly gross 30,200 / 22 working days × 2 LOP days
    assert.equal(payslip.lopDays, 2);
    assert.equal(payslip.deductions.lop, Number((30200 / 22 * 2).toFixed(2)));
    assert.equal(payslip.grossAfterLOP, Number((30200 - 30200 / 22 * 2).toFixed(2)));
  } finally { reset(); }

  employee.joiningDate = new Date("2026-10-15T18:30:00.000Z"); // joins 16 Oct IST
  employee.salary.customComponents = [{ code: "DA", name: "DA", amount: 2200 }];
  attendanceTotals = { present: 12, halfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  try {
    const payslip = await run();
    const factor = payslip.earnings.basic / 20000;
    assert.ok(factor > 0 && factor < 1);
    assert.equal(payslip.earnings.customComponents[0].amount, Number((2200 * factor).toFixed(2)));
  } finally { reset(); }
});

test("PF-1 run: non-taxable components stay out of the TDS projection", async () => {
  employee.salary = { basic: 100000, hra: 10000, customComponents: [{ code: "REIMB", name: "Reimbursement", amount: 20000, taxable: false }] };
  policy.tdsConfig = { enabled: true, taxRegime: "new" };
  try {
    const payslip = await run();
    // Oct = month 7 of FY, 6 months left: taxable 1.1L × 6 (no prior payslips), reimbursement excluded
    assert.equal(payslip.grossSalary, 130000);
    assert.equal(payslip.taxBreakdown.projectedAnnualGross, 660000);
  } finally { reset(); }
});

// ─── PF-5 ──────────────────────────────────────────────────────────────────
test("PF-5 rules: exit month uses only income actually paid, and all tax is due now", () => {
  const normal = rules.projectAnnualIncomeForTDS({ month: 10, priorGross: 600000, currentGross: 100000, monthlyGross: 100000 });
  assert.deepEqual(normal, { projectedAnnualGross: 1200000, remainingMonths: 6 });
  const exit = rules.projectAnnualIncomeForTDS({ month: 10, priorGross: 600000, currentGross: 100000, monthlyGross: 100000, isExitMonth: true });
  assert.deepEqual(exit, { projectedAnnualGross: 700000, remainingMonths: 1 });
});

test("PF-5 rules: exit month is judged in the company timezone", () => {
  const firstOctIST = new Date("2026-09-30T18:30:00.000Z"); // stored IST midnight of 1 Oct
  assert.equal(rules.isExitInPayrollMonth(firstOctIST, 2026, 10, "Asia/Kolkata"), true);
  assert.equal(rules.isExitInPayrollMonth(firstOctIST, 2026, 9, "Asia/Kolkata"), false);
  assert.equal(rules.isExitInPayrollMonth(null, 2026, 10), false);
});

test("PF-5 run: an employee leaving in October pays the rest of the year's tax on actual income", async () => {
  employee.salary = { basic: 150000, hra: 50000 };
  employee.exitDate = new Date("2026-10-30T18:30:00.000Z"); // last day 31 Oct IST
  policy.tdsConfig = { enabled: true, taxRegime: "new" };
  priorPayslips = Array.from({ length: 6 }, () => ({ grossSalary: 200000, grossAfterLOP: 200000, deductions: { lop: 0, tds: 20000 } }));
  try {
    const payslip = await run();
    const expected = calculateTDSNewRegime(200000 * 7 - 75000); // Apr–Oct actually paid
    assert.equal(payslip.taxBreakdown.isExitMonth, true);
    assert.equal(payslip.taxBreakdown.remainingMonths, 1);
    assert.equal(payslip.taxBreakdown.projectedAnnualGross, 1400000);
    assert.equal(payslip.deductions.tds, Math.max(0, Math.ceil(expected.totalTax - 120000)));
  } finally { reset(); }
});

test("PF-5 run: an employee not leaving keeps the normal projection", async () => {
  employee.salary = { basic: 150000, hra: 50000 };
  policy.tdsConfig = { enabled: true, taxRegime: "new" };
  try {
    const payslip = await run();
    assert.equal(payslip.taxBreakdown.isExitMonth, false);
    assert.equal(payslip.taxBreakdown.remainingMonths, 6);
  } finally { reset(); }
});

// ─── PF-3 ──────────────────────────────────────────────────────────────────
test("PF-3: a batch run with no failures is finalizable", async () => {
  try {
    const result = await runForTenant(companyId, unitId, "2026-10", "admin", { orgId });
    assert.equal(result.summary.processed, 1);
    assert.equal(result.finalizable, true);
  } finally { reset(); }
});

test("PF-3: a batch run with a failed employee is not finalizable", async () => {
  const other = { ...baseEmployee(), _id: new mongoose.Types.ObjectId(), name: "Ravi" };
  employees = [employee, other];
  failPolicyFor = other._id;
  try {
    const result = await runForTenant(companyId, unitId, "2026-10", "admin", { orgId });
    assert.equal(result.summary.processed, 1);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.finalizable, false);
    assert.match(result.message, /Failed: 1/);
  } finally { reset(); }
});
