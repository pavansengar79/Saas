"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertPayrollRunDateReached,
  calculateOvertimePay,
  calculatePayrollEligibility,
  assertPayslipCanBeRecalculated,
  resolveProfessionalTaxState,
  calculateStatutoryDeductions,
  getFinancialYear,
} = require("./payrollRunRules");

test("payroll run date blocks early and future periods", () => {
  const now = new Date(2026, 2, 20);

  assert.throws(() => assertPayrollRunDateReached(2026, 3, 25, now), /on or after day 25/);
  assert.throws(() => assertPayrollRunDateReached(2026, 4, 1, now), /future period/);
  assert.doesNotThrow(() => assertPayrollRunDateReached(2026, 2, 28, now));
});

test("payroll run date clamps to the final day of a short month", () => {
  assert.throws(
    () => assertPayrollRunDateReached(2026, 2, 31, new Date(2026, 1, 27)),
    /on or after day 28/
  );
  assert.doesNotThrow(() => assertPayrollRunDateReached(2026, 2, 31, new Date(2026, 1, 28)));
});

test("salary overtime uses attendance multiplier and payroll monthly cap", () => {
  const result = calculateOvertimePay({
    detectedHours: 12,
    attendanceOvertime: { enabled: true, compensationType: "salary", rateMultiplier: 2 },
    payrollOvertime: { enabled: true, capHoursPerMonth: 10, payableComponent: "BASIC" },
    salary: { basic: 20800 },
    workingDays: 26,
    standardHours: 8,
  });

  assert.deepEqual(result, { hours: 10, rate: 100, multiplier: 2, amount: 2000 });
});

test("comp-off overtime is detected by attendance but not paid in payroll", () => {
  const result = calculateOvertimePay({
    detectedHours: 3,
    attendanceOvertime: { enabled: true, compensationType: "comp_off", rateMultiplier: 2 },
    payrollOvertime: { enabled: true, payableComponent: "BASIC" },
    salary: { basic: 20800 },
    workingDays: 26,
    standardHours: 8,
  });

  assert.equal(result.amount, 0);
  assert.equal(result.hours, 0);
});

test("mid-month joiners are eligible only from their joining date", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 9,
    joiningDate: "2026-09-15T00:00:00.000Z",
  });

  assert.equal(result.totalWorkingDays, 22);
  assert.equal(result.eligibleWorkingDays, 12);
  assert.equal(result.proRataFactor, 12 / 22);
});

test("payroll cycle ends eligibility before the rest of the month", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2026-10-06T00:00:00.000Z",
    startDay: 1,
    endDay: 13,
  });

  assert.equal(result.totalWorkingDays, 9);
  assert.equal(result.actualPayableDays, 13);
  assert.equal(result.eligibleCalendarDays, 8);
  assert.equal(result.monthlyWorkingDays, 22);
  assert.equal(result.eligibleWorkingDays, 6);
  assert.equal(result.proRataFactor, 6 / 22);
  assert.equal(result.eligibilityEnd.toISOString(), "2026-10-13T23:59:59.999Z");
});

test("fixed 30-day policy prorates only eligible cycle days", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2026-10-06T00:00:00.000Z",
    startDay: 1,
    endDay: 13,
    fixedWorkingDays: 30,
  });

  assert.equal(result.totalWorkingDays, 9);
  assert.equal(result.eligibleWorkingDays, 6);
  assert.equal(result.salaryDivisorDays, 30);
  assert.equal(result.proRataFactor, 6 / 30);
});

test("exit dates constrain eligibility and future joiners are ineligible", () => {
  const exiting = calculatePayrollEligibility({
    year: 2026,
    month: 9,
    joiningDate: "2025-01-01T00:00:00.000Z",
    exitDate: "2026-09-15T00:00:00.000Z",
  });
  const futureJoiner = calculatePayrollEligibility({
    year: 2026,
    month: 9,
    joiningDate: "2026-10-01T00:00:00.000Z",
  });

  assert.equal(exiting.eligibleWorkingDays, 11);
  assert.equal(futureJoiner.eligibleWorkingDays, 0);
  assert.equal(futureJoiner.proRataFactor, 0);
});

test("published and paid payslips cannot be recalculated", () => {
  assert.doesNotThrow(() => assertPayslipCanBeRecalculated("DRAFT"));
  assert.throws(() => assertPayslipCanBeRecalculated("PUBLISHED"), /cannot be recalculated/);
  assert.throws(() => assertPayslipCanBeRecalculated("PAID"), /cannot be recalculated/);
});

test("PF honors its ceiling and actual-basic policy", () => {
  const capped = calculateStatutoryDeductions({
    basic: 16000,
    grossSalary: 30000,
    taxCompliance: { pfEnabled: true, pfCeilingAmount: 15000 },
  });
  const actual = calculateStatutoryDeductions({
    basic: 16000,
    grossSalary: 30000,
    taxCompliance: { pfEnabled: true, pfCeilingAmount: 15000, pfApplyOnActualBasic: true },
  });

  assert.equal(capped.pfEmployee, 1800);
  assert.equal(capped.pfEmployer, 1800);
  assert.equal(actual.pfEmployee, 1920);
});

test("ESI applies at or below its wage ceiling and stops above it", () => {
  const eligible = calculateStatutoryDeductions({
    basic: 10000,
    grossSalary: 20999,
    taxCompliance: { esiEnabled: true, esiWageCeiling: 21000 },
  });
  const ineligible = calculateStatutoryDeductions({
    basic: 10000,
    grossSalary: 21001,
    taxCompliance: { esiEnabled: true, esiWageCeiling: 21000 },
  });

  assert.equal(eligible.esiEmployee, 157.49);
  assert.equal(eligible.esiEmployer, 682.47);
  assert.equal(ineligible.esiEmployee, 0);
  assert.equal(ineligible.esiEmployer, 0);
});

test("PT uses location precedence and remains zero when disabled", () => {
  const state = resolveProfessionalTaxState({
    unitState: "mh",
    companyState: "KA",
    employeeState: "DL",
  });
  const enabled = calculateStatutoryDeductions({
    basic: 5000,
    grossSalary: 8000,
    taxCompliance: { pfEnabled: false, esiEnabled: false, ptEnabled: true },
    ptState: state,
  });
  const disabled = calculateStatutoryDeductions({
    basic: 5000,
    grossSalary: 8000,
    taxCompliance: { pfEnabled: false, esiEnabled: false, ptEnabled: false },
    ptState: "MH",
  });

  assert.equal(state, "MH");
  assert.equal(enabled.professionalTax, 175);
  assert.equal(disabled.professionalTax, 0);
});

test("TDS declaration lookup uses the April-to-March financial year", () => {
  assert.equal(getFinancialYear(2026, 3), "2025-2026");
  assert.equal(getFinancialYear(2026, 4), "2026-2027");
});