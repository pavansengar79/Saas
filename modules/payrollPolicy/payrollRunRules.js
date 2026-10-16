"use strict";

const AppError = require("../../utils/appError");
const { calculatePT } = require("../../config/ptSlabs");

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
}) => {
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1) - 1);
  const cycleStart = new Date(Date.UTC(year, month - 1, startDay));
  const cycleEnd = new Date(Date.UTC(year, month - 1, Math.min(endDay, periodEnd.getUTCDate()) + 1) - 1);
  const joinedAt = joiningDate ? new Date(joiningDate) : periodStart;
  const exitedAt = exitDate ? new Date(exitDate) : periodEnd;
  const eligibilityStart = new Date(joinedAt > cycleStart ? joinedAt : cycleStart);
  const eligibilityEnd = new Date(exitedAt < cycleEnd ? exitedAt : cycleEnd);
  if (proRata.includeJoiningDay === false && joinedAt >= cycleStart && joinedAt <= cycleEnd) {
    eligibilityStart.setUTCDate(eligibilityStart.getUTCDate() + 1);
  }
  if (proRata.includeExitDay === false && exitedAt >= cycleStart && exitedAt <= cycleEnd) {
    eligibilityEnd.setUTCDate(eligibilityEnd.getUTCDate() - 1);
  }
  const monthlyWorkingDays = countWorkingDays(periodStart, periodEnd, workDays);
  const totalWorkingDays = countWorkingDays(cycleStart, cycleEnd, workDays);
  const actualPayableDays = Math.max(0, (cycleEnd - cycleStart + 1) / MS_PER_DAY);
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
    && cycleEnd.getTime() === periodEnd.getTime();
  const fullCycleFactor = fullMonthCycle ? 1 : (salaryDivisorDays ? totalWorkingDays / salaryDivisorDays : 0);
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

/**
 * Calculates statutory employee deductions and employer contributions.
 * @param {object} input Salary and policy inputs.
 * @returns {object} Statutory amounts.
 */
const calculateStatutoryDeductions = ({ basic, fullBasic = basic, grossSalary, standardGross = grossSalary, taxCompliance = {}, ptState }) => {
  const pfEnabled = taxCompliance.pfEnabled !== false;
  const pfCeiling = taxCompliance.pfCeilingAmount ?? 15000;
  const pfBase = taxCompliance.pfApplyOnActualBasic
    ? basic
    : Math.min(fullBasic, pfCeiling) * (fullBasic > 0 ? basic / fullBasic : 0);
  const pfEmployee = pfEnabled
    ? Number((pfBase * ((taxCompliance.pfEmployeeRate ?? 12) / 100)).toFixed(2))
    : 0;
  const pfEmployer = pfEnabled
    ? Number((pfBase * ((taxCompliance.pfEmployerRate ?? 12) / 100)).toFixed(2))
    : 0;

  const esiEnabled = taxCompliance.esiEnabled !== false;
  const esiWageCeiling = taxCompliance.esiWageCeiling ?? 21000;
  const esiApplicable = esiEnabled && standardGross <= esiWageCeiling;
  const esiEmployee = esiApplicable
    ? Number((grossSalary * ((taxCompliance.esiEmployeeRate ?? 0.75) / 100)).toFixed(2))
    : 0;
  const esiEmployer = esiApplicable
    ? Number((grossSalary * ((taxCompliance.esiEmployerRate ?? 3.25) / 100)).toFixed(2))
    : 0;

  const professionalTax = taxCompliance.ptEnabled === true && ptState
    ? calculatePT(ptState, grossSalary)
    : 0;

  return { pfEmployee, pfEmployer, esiEmployee, esiEmployer, professionalTax };
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

module.exports = {
  assertPayrollRunDateReached,
  calculateOvertimePay,
  calculatePayrollEligibility,
  assertPayslipCanBeRecalculated,
  resolveProfessionalTaxState,
  calculateStatutoryDeductions,
  getFinancialYear,
};