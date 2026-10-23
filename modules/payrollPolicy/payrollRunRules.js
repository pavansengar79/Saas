"use strict";

const AppError = require("../../utils/appError");
const { calculatePT } = require("../../config/ptSlabs");
const moment = require("moment-timezone");

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const countWorkingDays = (start, end, workDays) => {
  let count = 0;
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    if (workDays.includes(DAY_NAMES[date.getUTCDay()])) count++;
  }
  return count;
};

/**
 * Resolves the portion of a payroll month for which an employee is eligible.
 * @param {object} input Payroll period and employment dates.
 * @returns {{periodStart: Date, periodEnd: Date, eligibilityStart: Date, eligibilityEnd: Date, totalWorkingDays: number, eligibleWorkingDays: number, proRataFactor: number}}
 */
const calculatePayrollEligibility = ({
  year,
  month,
  joiningDate,
  exitDate,
  workDays = ["MON", "TUE", "WED", "THU", "FRI"],
  startDay = 1,
  endDay = 31,
  fixedWorkingDays,
  proRata = {},
  asOf,
}) => {
  // P0-1: never assume a joining date — a missing one used to mean "full month paid".
  if (!joiningDate) {
    throw new AppError("Employee has no joining date set. Cannot run payroll.", 400);
  }
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1) - 1);
  const cycleStart = new Date(Date.UTC(year, month - 1, startDay));
  const cycleEnd = new Date(Date.UTC(year, month - 1, Math.min(endDay, periodEnd.getUTCDate()) + 1) - 1);
  const currentCycleEnd = asOf && asOf.getUTCFullYear() === year && asOf.getUTCMonth() === month - 1
    ? new Date(Math.min(cycleEnd.getTime(), asOf.getTime()))
    : cycleEnd;
  const joinedAt = new Date(joiningDate);
  const exitedAt = exitDate ? new Date(exitDate) : periodEnd;
  const eligibilityStart = new Date(joinedAt > cycleStart ? joinedAt : cycleStart);
  const eligibilityEnd = new Date(exitedAt < currentCycleEnd ? exitedAt : currentCycleEnd);
  if (proRata.includeJoiningDay === false && joinedAt >= cycleStart && joinedAt <= cycleEnd) {
    eligibilityStart.setUTCDate(eligibilityStart.getUTCDate() + 1);
  }
  if (proRata.includeExitDay === false && exitedAt >= cycleStart && exitedAt <= cycleEnd) {
    eligibilityEnd.setUTCDate(eligibilityEnd.getUTCDate() - 1);
  }
  const monthlyWorkingDays = countWorkingDays(periodStart, periodEnd, workDays);
  const totalWorkingDays = countWorkingDays(cycleStart, cycleEnd, workDays);
  const actualPayableDays = Math.max(0, Math.floor((currentCycleEnd - cycleStart + 1) / MS_PER_DAY));
  const eligibleCalendarDays = eligibilityStart > eligibilityEnd
    ? 0
    : Math.floor((Date.UTC(eligibilityEnd.getUTCFullYear(), eligibilityEnd.getUTCMonth(), eligibilityEnd.getUTCDate())
      - Date.UTC(eligibilityStart.getUTCFullYear(), eligibilityStart.getUTCMonth(), eligibilityStart.getUTCDate())) / MS_PER_DAY) + 1;
  const salaryDivisorDays = fixedWorkingDays || monthlyWorkingDays;
  const eligibleWorkingDays = eligibilityStart > eligibilityEnd
    ? 0
    : countWorkingDays(eligibilityStart, eligibilityEnd, workDays);
  const proRataDivisor = proRata.basis === "calendar_days"
    ? periodEnd.getUTCDate()
    : proRata.basis === "fixed_days"
      ? proRata.fixedDivisor || 26
      : salaryDivisorDays;
  const proRataDays = proRata.basis === "calendar_days"
    ? eligibleCalendarDays
    : eligibleWorkingDays;
  const fullMonthCycle = cycleStart.getTime() === periodStart.getTime()
    && currentCycleEnd.getTime() === periodEnd.getTime();
  const currentCycleWorkingDays = countWorkingDays(cycleStart, currentCycleEnd, workDays);
  const fullCycleFactor = fullMonthCycle ? 1 : (salaryDivisorDays ? currentCycleWorkingDays / salaryDivisorDays : 0);
  const fullMonthEmployment = eligibilityStart.getTime() === periodStart.getTime()
    && eligibilityEnd.getTime() === periodEnd.getTime();
  const proRataFactor = eligibleCalendarDays === 0
    ? 0
    : proRata.enabled === false || fullMonthEmployment
      ? fullCycleFactor
      : proRataDivisor ? proRataDays / proRataDivisor : 0;

  return {
    periodStart,
    periodEnd,
    eligibilityStart,
    eligibilityEnd,
    actualPayableDays,
    eligibleCalendarDays,
    totalWorkingDays,
    monthlyWorkingDays,
    salaryDivisorDays,
    eligibleWorkingDays,
    proRataFactor,
  };
};

/**
 * Prevents final payroll records from being replaced by a rerun.
 * @param {string | undefined} status Existing payslip status.
 * @returns {void}
 */
const assertPayslipCanBeRecalculated = (status) => {
  if (["PUBLISHED", "PAID"].includes(status)) {
    throw new AppError(`${status} payslips cannot be recalculated`, 409);
  }
};

/**
 * Resolves the PT jurisdiction without assuming a default state.
 * @param {object} input Available policy and location state codes.
 * @returns {string | null}
 */
const resolveProfessionalTaxState = ({ policyState, unitState, companyState, employeeState }) => {
  const state = policyState || unitState || companyState || employeeState;
  return state ? state.trim().toUpperCase() : null;
};

const EPF_CEILING_OLD = 15000;
const EPF_CEILING_NEW = 25000; // S.O. 5109(E), effective 17 Sep 2026

/**
 * P0-5: statutory EPF wage ceiling for a payroll month.
 * September 2026 has no official split method — "split" (default) prorates
 * 16 days at 15,000 and 14 days at 25,000; "full" applies 25,000 for the whole month.
 * Confirm the September choice with your CA and set taxCompliance.pfSep2026Transition.
 * @param {number} year Payroll year.
 * @param {number} month Payroll month (1-12).
 * @param {"split"|"full"} sepMode September 2026 treatment.
 * @returns {number} Ceiling in rupees.
 */
const getStatutoryPfCeiling = (year, month, sepMode = "split") => {
  const period = year * 12 + month;
  const sep2026 = 2026 * 12 + 9;
  if (period > sep2026) return EPF_CEILING_NEW;
  if (period < sep2026) return EPF_CEILING_OLD;
  if (sepMode === "full") return EPF_CEILING_NEW;
  return Math.round((EPF_CEILING_OLD * 16 + EPF_CEILING_NEW * 14) / 30);
};

const round2 = value => Number(value.toFixed(2));

/**
 * Calculates statutory employee deductions and employer contributions.
 * @param {object} input Salary and policy inputs.
 * @returns {object} Statutory amounts.
 */
const calculateStatutoryDeductions = ({
  basic,
  fullBasic = basic,
  customPfWages = 0,
  grossSalary,
  standardGross = grossSalary,
  taxCompliance = {},
  ptState,
  year,
  month,
  epsEligible = true,
}) => {
  const pfEnabled = taxCompliance.pfEnabled !== false;
  const statutoryCeiling = year && month
    ? getStatutoryPfCeiling(year, month, taxCompliance.pfSep2026Transition)
    : EPF_CEILING_OLD;
  // A stale policy value (15000) must not undercut the statutory ceiling.
  const pfCeiling = Math.max(taxCompliance.pfCeilingAmount ?? 0, statutoryCeiling);
  const payableShare = fullBasic > 0 ? basic / fullBasic : 0;
  // PF-1: custom components marked pfApplicable (e.g. DA) are PF wages too.
  // customPfWages is the full monthly amount; it is paid in the same share as basic.
  const fullPfWages = fullBasic + customPfWages;
  const pfBase = taxCompliance.pfApplyOnActualBasic
    ? basic + customPfWages * payableShare
    : Math.min(fullPfWages, pfCeiling) * payableShare;
  const pfEmployee = pfEnabled
    ? round2(pfBase * ((taxCompliance.pfEmployeeRate ?? 12) / 100))
    : 0;
  const pfEmployer = pfEnabled
    ? round2(pfBase * ((taxCompliance.pfEmployerRate ?? 12) / 100))
    : 0;

  // P0-6: employer PF breakup. EPS is always on wages capped at the ceiling,
  // even when PF is paid on actual basic; the rest of the 12% goes to EPF.
  const epsWage = Math.min(pfBase, pfCeiling);
  const eps = pfEnabled && epsEligible ? Math.round(epsWage * 0.0833) : 0;
  const pfEmployerBreakup = pfEnabled
    ? {
      eps,
      epf: round2(Math.max(0, pfEmployer - eps)),
      edli: Math.round(epsWage * 0.005),
      admin: Math.round(pfBase * 0.005),
    }
    : { eps: 0, epf: 0, edli: 0, admin: 0 };

  const esiEnabled = taxCompliance.esiEnabled !== false;
  const esiWageCeiling = taxCompliance.esiWageCeiling ?? 21000;
  const esiApplicable = esiEnabled && standardGross <= esiWageCeiling;
  const esiEmployee = esiApplicable
    ? round2(grossSalary * ((taxCompliance.esiEmployeeRate ?? 0.75) / 100))
    : 0;
  const esiEmployer = esiApplicable
    ? round2(grossSalary * ((taxCompliance.esiEmployerRate ?? 3.25) / 100))
    : 0;

  const professionalTax = taxCompliance.ptEnabled === true && ptState
    ? calculatePT(ptState, grossSalary)
    : 0;

  return { pfEmployee, pfEmployer, pfEmployerBreakup, pfCeiling, esiEmployee, esiEmployer, professionalTax };
};

/**
 * EPS stops at 58. Age is checked on the last day of the payroll month.
 * @param {Date|string|undefined} dateOfBirth Employee DOB.
 * @param {number} year Payroll year.
 * @param {number} month Payroll month (1-12).
 * @returns {boolean}
 */
const isEpsEligibleByAge = (dateOfBirth, year, month) => {
  if (!dateOfBirth) return true;
  const dob = new Date(dateOfBirth);
  const periodEnd = new Date(Date.UTC(year, month, 0));
  let age = periodEnd.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = periodEnd.getUTCMonth() < dob.getUTCMonth()
    || (periodEnd.getUTCMonth() === dob.getUTCMonth() && periodEnd.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age--;
  return age < 58;
};

/**
 * P0-4: monthly TDS from the financial-year projection.
 * Months left includes the current month (Apr = 12, Mar = 1).
 * @param {object} input Prior FY earnings/TDS and current month figures.
 * @returns {{projectedAnnualGross: number, remainingMonths: number, monthlyTDS: number}}
 */
const projectAnnualIncomeForTDS = ({ month, priorGross = 0, currentGross, monthlyGross, isExitMonth = false }) => {
  // PF-5: in the exit month there is no future salary. Tax is on what was
  // actually paid this FY, and whatever is still due is deducted now.
  if (isExitMonth) {
    return { projectedAnnualGross: round2(priorGross + currentGross), remainingMonths: 1 };
  }
  const remainingMonths = month >= 4 ? 16 - month : 4 - month;
  const projectedAnnualGross = priorGross + currentGross + monthlyGross * (remainingMonths - 1);
  return { projectedAnnualGross: round2(projectedAnnualGross), remainingMonths };
};

/**
 * Spreads the tax still due over the months left in the FY.
 * @param {number} annualTax Total tax on the projected income.
 * @param {number} priorTDS TDS already deducted this FY.
 * @param {number} remainingMonths Months left including the current one.
 * @returns {number}
 */
const calculateMonthlyTDS = (annualTax, priorTDS, remainingMonths) => (
  Math.max(0, Math.ceil((annualTax - priorTDS) / Math.max(remainingMonths, 1)))
);

/**
 * Calendar periods (year, month) that come before this month in the same FY.
 * @param {number} year Payroll year.
 * @param {number} month Payroll month.
 * @returns {Array<{year: number, month: number}>}
 */
const getPriorFinancialYearPeriods = (year, month) => {
  const fyStartYear = month >= 4 ? year : year - 1;
  const periods = [];
  for (let y = fyStartYear, m = 4; y * 12 + m < year * 12 + month; m === 12 ? (y++, m = 1) : m++) {
    periods.push({ year: y, month: m });
  }
  return periods;
};

/**
 * Resolves the April-to-March Indian financial year for a payroll period.
 * @param {number} year Calendar year.
 * @param {number} month Calendar month (1-12).
 * @returns {string} Financial year label.
 */
const getFinancialYear = (year, month) => (
  month >= 4 ? `${year}-${year + 1}` : `${year - 1}-${year}`
);

/**
 * Ensures a payroll period has reached its configured run date.
 * @param {number} year Payroll period year.
 * @param {number} month Payroll period month (1-12).
 * @param {number} payrollRunDay Configured run day.
 * @param {Date} now Current date, injectable for tests.
 * @returns {void}
 */
const assertPayrollRunDateReached = (year, month, payrollRunDay, now = new Date()) => {
  const currentPeriod = now.getFullYear() * 12 + now.getMonth();
  const requestedPeriod = year * 12 + month - 1;

  if (requestedPeriod < currentPeriod) return;
  if (requestedPeriod > currentPeriod) {
    throw new AppError("Payroll cannot be run for a future period", 400);
  }

  const lastDay = new Date(year, month, 0).getDate();
  const effectiveRunDay = Math.min(payrollRunDay ?? 28, lastDay);
  if (now.getDate() < effectiveRunDay) {
    throw new AppError(
      `Payroll for this period can be run on or after day ${effectiveRunDay}`,
      400
    );
  }
};

const getPayableComponentAmount = (salary, componentCode) => {
  const normalizedCode = String(componentCode || "BASIC").toUpperCase();
  const standardComponents = {
    BASIC: salary.basic,
    HRA: salary.hra,
    TRAVEL_ALLOWANCE: salary.travelAllowance,
    MEDICAL_ALLOWANCE: salary.medicalAllowance,
    SPECIAL_ALLOWANCE: salary.specialAllowance,
  };

  if (standardComponents[normalizedCode] !== undefined) {
    return standardComponents[normalizedCode] || 0;
  }

  return salary.customComponents?.find(component => component.code === normalizedCode)?.amount || 0;
};

/**
 * Calculates payable overtime from attendance and payroll policy controls.
 * @param {object} input Overtime calculation inputs.
 * @returns {{hours: number, rate: number, multiplier: number, amount: number}}
 */
const calculateOvertimePay = ({
  detectedHours,
  attendanceOvertime,
  payrollOvertime,
  salary,
  workingDays,
  standardHours,
}) => {
  const multiplier = attendanceOvertime?.rateMultiplier ?? 1.5;
  const isCashOvertime = attendanceOvertime?.enabled
    && attendanceOvertime.compensationType === "salary"
    && payrollOvertime?.enabled;

  if (!isCashOvertime) return { hours: 0, rate: 0, multiplier, amount: 0 };

  const monthlyCap = payrollOvertime.capHoursPerMonth;
  const payableHours = monthlyCap == null
    ? detectedHours || 0
    : Math.min(detectedHours || 0, monthlyCap);
  const componentAmount = getPayableComponentAmount(salary, payrollOvertime.payableComponent);
  const divisorDays = Math.max(workingDays || 0, 1);
  const divisorHours = Math.max(standardHours || 0, 1);
  const hourlyRate = componentAmount / divisorDays / divisorHours;
  const amount = Number((payableHours * multiplier * hourlyRate).toFixed(2));

  return {
    hours: Number(payableHours.toFixed(2)),
    rate: Number(hourlyRate.toFixed(2)),
    multiplier,
    amount,
  };
};

/**
 * PF-1: custom salary components (DA, food, internet …) for one payroll month.
 * Amounts are prorated with the same earnings factor as basic / HRA.
 * @param {Array} components employee.salary.customComponents
 * @param {number} earningsFactor proration factor used for the fixed components
 * @returns {{items: Array, monthly: number, earned: number, monthlyNonTaxable: number, earnedNonTaxable: number, monthlyPf: number}}
 */
const summarizeCustomComponents = (components = [], earningsFactor = 1) => {
  const summary = { items: [], monthly: 0, earned: 0, monthlyNonTaxable: 0, earnedNonTaxable: 0, monthlyPf: 0 };
  for (const component of components || []) {
    const amount = Math.max(0, Number(component?.amount) || 0);
    if (!amount) continue;
    const earned = round2(amount * earningsFactor);
    const taxable = component.taxable !== false;
    const pfApplicable = component.pfApplicable === true;
    summary.items.push({
      code: component.code,
      name: component.name,
      amount: earned,
      taxable,
      pfApplicable,
      esiApplicable: component.esiApplicable === true,
    });
    summary.monthly += amount;
    summary.earned += earned;
    if (!taxable) {
      summary.monthlyNonTaxable += amount;
      summary.earnedNonTaxable += earned;
    }
    if (pfApplicable) summary.monthlyPf += amount;
  }
  for (const key of ["monthly", "earned", "monthlyNonTaxable", "earnedNonTaxable", "monthlyPf"]) {
    summary[key] = round2(summary[key]);
  }
  return summary;
};

/**
 * PF-5: true when the exit date falls inside the payroll month, judged in the
 * company timezone (dates are stored at local midnight, e.g. 18:30Z for IST).
 * @param {Date|string|null} exitDate
 * @param {number} year
 * @param {number} month 1-12
 * @param {string} timezone
 * @returns {boolean}
 */
const isExitInPayrollMonth = (exitDate, year, month, timezone = "Asia/Kolkata") => {
  if (!exitDate) return false;
  const exit = moment(exitDate).tz(timezone);
  return exit.isValid() && exit.year() === year && exit.month() + 1 === month;
};

module.exports = {
  summarizeCustomComponents,
  isExitInPayrollMonth,
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
};