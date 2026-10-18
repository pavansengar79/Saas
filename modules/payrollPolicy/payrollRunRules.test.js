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
  getStatutoryPfCeiling,
  isEpsEligibleByAge,
  projectAnnualIncomeForTDS,
  calculateMonthlyTDS,
  getPriorFinancialYearPeriods,
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

test("calendar-day proration follows policy and can exclude joining day", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2026-10-06T00:00:00.000Z",
    startDay: 1,
    endDay: 13,
    proRata: { basis: "calendar_days", includeJoiningDay: false },
  });

  assert.equal(result.eligibleCalendarDays, 7);
  assert.equal(result.eligibleWorkingDays, 5);
  assert.equal(result.proRataFactor, 7 / 31);
});

test("fixed-day proration uses the policy divisor", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2026-10-06T00:00:00.000Z",
    proRata: { basis: "fixed_days", fixedDivisor: 26 },
  });

  assert.equal(result.proRataFactor, 19 / 26);
});

test("fixed divisor does not reduce full-month earnings", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2025-01-01T00:00:00.000Z",
    fixedWorkingDays: 30,
    proRata: { basis: "fixed_days", fixedDivisor: 26 },
  });

  assert.equal(result.eligibleWorkingDays, 22);
  assert.equal(result.proRataFactor, 1);
});

test("disabled proration pays the full cycle portion for a mid-month joiner", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2026-10-06T00:00:00.000Z",
    proRata: { enabled: false },
  });

  assert.equal(result.eligibleWorkingDays, 19);
  assert.equal(result.proRataFactor, 1);
});

test("current-month payroll excludes future days from eligibility and earnings", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2025-01-01T00:00:00.000Z",
    asOf: new Date("2026-10-16T23:59:59.999Z"),
  });

  assert.equal(result.totalWorkingDays, 22);
  assert.equal(result.actualPayableDays, 16);
  assert.equal(result.eligibleWorkingDays, 12);
  assert.equal(result.proRataFactor, 12 / 22);

  const withoutProration = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2025-01-01T00:00:00.000Z",
    asOf: new Date("2026-10-16T23:59:59.999Z"),
    proRata: { enabled: false },
  });
  assert.equal(withoutProration.proRataFactor, 12 / 22);
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

test("PF prorates the capped full-month basic when payable basic is reduced", () => {
  const result = calculateStatutoryDeductions({
    basic: 10000,
    fullBasic: 20000,
    grossSalary: 15000,
    standardGross: 30000,
    taxCompliance: { pfEnabled: true, pfCeilingAmount: 15000, esiEnabled: false },
  });

  assert.equal(result.pfEmployee, 900);
  assert.equal(result.pfEmployer, 900);
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

test("ESI uses standard wages for eligibility and earned wages for contributions", () => {
  const excluded = calculateStatutoryDeductions({
    basic: 8000,
    grossSalary: 18000,
    standardGross: 25000,
    taxCompliance: { pfEnabled: false, esiEnabled: true },
  });
  const included = calculateStatutoryDeductions({
    basic: 8000,
    grossSalary: 18000,
    standardGross: 20000,
    taxCompliance: { pfEnabled: false, esiEnabled: true },
  });

  assert.equal(excluded.esiEmployee, 0);
  assert.equal(excluded.esiEmployer, 0);
  assert.equal(included.esiEmployee, 135);
  assert.equal(included.esiEmployer, 585);
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
// ── Payroll P0 fixes ────────────────────────────────────────────

test("P0-1 missing joining date blocks payroll instead of paying a full month", () => {
  assert.throws(
    () => calculatePayrollEligibility({ year: 2026, month: 10 }),
    /no joining date/
  );
});

test("P0-2 overtime rate uses full monthly basic, not the prorated basic", () => {
  // 15 of 27 working days → prorated basic would be 16,667; OT must still use 30,000.
  const result = calculateOvertimePay({
    detectedHours: 4,
    attendanceOvertime: { enabled: true, compensationType: "salary", rateMultiplier: 2 },
    payrollOvertime: { enabled: true, payableComponent: "BASIC" },
    salary: { basic: 30000 },
    workingDays: 27,
    standardHours: 8,
  });
  assert.equal(result.rate, 138.89);
  assert.equal(result.amount, 1111.11);
});

test("P0-3 full month is paid when run mid-month without asOf", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2025-01-01T00:00:00.000Z",
    workDays: ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
  });
  assert.equal(result.proRataFactor, 1);
  assert.equal(result.eligibleWorkingDays, 27);
});

test("P0-3 mid-month joiner gets 15/27 of basic", () => {
  const result = calculatePayrollEligibility({
    year: 2026,
    month: 10,
    joiningDate: "2026-10-15T00:00:00.000Z",
    workDays: ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
  });
  assert.equal(result.eligibleWorkingDays, 15);
  assert.equal(Math.round(30000 * result.proRataFactor), 16667);
});

test("P0-4 FY periods and months remaining", () => {
  assert.deepEqual(getPriorFinancialYearPeriods(2026, 4), []);
  assert.equal(getPriorFinancialYearPeriods(2026, 10).length, 6);
  assert.deepEqual(getPriorFinancialYearPeriods(2027, 2).at(-1), { year: 2027, month: 1 });
  assert.equal(getPriorFinancialYearPeriods(2027, 3).length, 11);
  assert.equal(projectAnnualIncomeForTDS({ month: 4, currentGross: 0, monthlyGross: 0 }).remainingMonths, 12);
  assert.equal(projectAnnualIncomeForTDS({ month: 3, currentGross: 0, monthlyGross: 0 }).remainingMonths, 1);
});

test("P0-4 October joiner is projected only for Oct–Mar, not 12 months", () => {
  const { projectedAnnualGross, remainingMonths } = projectAnnualIncomeForTDS({
    month: 10, priorGross: 0, currentGross: 100000, monthlyGross: 100000,
  });
  assert.equal(remainingMonths, 6);
  assert.equal(projectedAnnualGross, 600000);
});

test("P0-4 monthly TDS spreads remaining tax over remaining months", () => {
  assert.equal(calculateMonthlyTDS(60000, 0, 12), 5000);
  assert.equal(calculateMonthlyTDS(60000, 30000, 6), 5000);
  assert.equal(calculateMonthlyTDS(60000, 70000, 3), 0);
});

test("P0-5 EPF ceiling switches to 25,000 from Sep 2026", () => {
  assert.equal(getStatutoryPfCeiling(2026, 8), 15000);
  assert.equal(getStatutoryPfCeiling(2026, 9), 19667);
  assert.equal(getStatutoryPfCeiling(2026, 9, "full"), 25000);
  assert.equal(getStatutoryPfCeiling(2026, 10), 25000);

  const result = calculateStatutoryDeductions({
    basic: 30000, grossSalary: 60000,
    taxCompliance: { pfEnabled: true, pfCeilingAmount: 15000, esiEnabled: false },
    year: 2026, month: 10,
  });
  assert.equal(result.pfCeiling, 25000);
  assert.equal(result.pfEmployee, 3000);
  assert.equal(result.pfEmployer, 3000);
});

test("P0-6 employer PF breakup: EPS 2083, EPF 917, EDLI 125, admin 125", () => {
  const result = calculateStatutoryDeductions({
    basic: 30000, grossSalary: 60000,
    taxCompliance: { pfEnabled: true, esiEnabled: false },
    year: 2026, month: 10,
  });
  assert.deepEqual(result.pfEmployerBreakup, { eps: 2083, epf: 917, edli: 125, admin: 125 });
});

test("P0-6 EPS is zero at 58+ and the full 12% goes to EPF", () => {
  assert.equal(isEpsEligibleByAge("1968-10-31", 2026, 10), false);
  assert.equal(isEpsEligibleByAge("1968-11-01", 2026, 10), true);
  const result = calculateStatutoryDeductions({
    basic: 30000, grossSalary: 60000,
    taxCompliance: { pfEnabled: true, esiEnabled: false },
    year: 2026, month: 10, epsEligible: false,
  });
  assert.equal(result.pfEmployerBreakup.eps, 0);
  assert.equal(result.pfEmployerBreakup.epf, 3000);
});
