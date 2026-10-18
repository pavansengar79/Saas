// modules/payrollPolicy/payslip/payslipRevision.js
// P0-7 — controlled correction of a PUBLISHED / PAID payslip with an audit trail.
"use strict";

const AppError = require("../../../utils/appError");

const EARNING_FIELDS = ["basic", "hra", "travelAllowance", "medicalAllowance", "specialAllowance", "overtime", "bonus", "arrears"];
const DEDUCTION_FIELDS = ["pf", "esi", "tds", "lop", "professionalTax", "advance", "other"];
const round2 = value => Number(Number(value).toFixed(2));

const pickAmounts = (source = {}, fields) => Object.fromEntries(fields.map(field => [field, round2(source[field] || 0)]));

const snapshot = payslip => ({
  earnings: pickAmounts(payslip.earnings, EARNING_FIELDS),
  deductions: pickAmounts(payslip.deductions, DEDUCTION_FIELDS),
  grossSalary: payslip.grossSalary,
  grossAfterLOP: payslip.grossAfterLOP,
  netSalary: payslip.netSalary,
});

const readChanges = (changes, fields, label) => {
  if (changes == null) return {};
  if (typeof changes !== "object" || Array.isArray(changes)) throw new AppError(`${label} must be an object`, 400);
  const result = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!fields.includes(key)) throw new AppError(`${label}.${key} cannot be revised`, 400);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new AppError(`${label}.${key} must be a number of 0 or more`, 400);
    }
    result[key] = round2(value);
  }
  return result;
};

/**
 * Applies a revision to a payslip document (mutates it) and records the audit entry.
 * Gross / gross after LOP / net are recomputed the same way the payroll run does.
 * @param {object} payslip Mongoose payslip document.
 * @param {{reason: string, earnings?: object, deductions?: object}} body Revision request.
 * @param {string} userId Who is revising.
 * @returns {object} The revised payslip.
 */
const applyPayslipRevision = (payslip, body = {}, userId) => {
  if (!["PUBLISHED", "PAID"].includes(payslip.status)) {
    throw new AppError("Only PUBLISHED or PAID payslips can be revised. Re-run payroll for a DRAFT.", 400);
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10) throw new AppError("A revision reason of at least 10 characters is required", 400);

  const earningChanges = readChanges(body.earnings, EARNING_FIELDS, "earnings");
  const deductionChanges = readChanges(body.deductions, DEDUCTION_FIELDS, "deductions");
  if (!Object.keys(earningChanges).length && !Object.keys(deductionChanges).length) {
    throw new AppError("Nothing to revise — send earnings or deductions to change", 400);
  }

  const oldValues = snapshot(payslip);
  const earnings = { ...oldValues.earnings, ...earningChanges };
  const deductions = { ...oldValues.deductions, ...deductionChanges };

  const grossSalary = round2(EARNING_FIELDS.reduce((sum, field) => sum + earnings[field], 0));
  const grossAfterLOP = round2(grossSalary - deductions.lop);
  const netSalary = round2(grossAfterLOP
    - (deductions.pf + deductions.esi + deductions.tds + deductions.professionalTax + deductions.advance + deductions.other));
  if (grossAfterLOP < 0) throw new AppError("LOP cannot be more than gross salary", 400);
  if (netSalary < 0) throw new AppError("Deductions cannot be more than gross salary after LOP", 400);

  for (const field of EARNING_FIELDS) payslip.earnings[field] = earnings[field];
  for (const field of DEDUCTION_FIELDS) payslip.deductions[field] = deductions[field];
  payslip.grossSalary = grossSalary;
  payslip.grossAfterLOP = grossAfterLOP;
  payslip.netSalary = netSalary;
  payslip.isRevised = true;
  payslip.revisionCount = (payslip.revisionCount || 0) + 1;
  payslip.revisionHistory.push({
    revisedAt: new Date(),
    revisedBy: userId,
    reason,
    statusAtRevision: payslip.status,
    oldValues,
    newValues: snapshot(payslip),
  });
  return payslip;
};

module.exports = { applyPayslipRevision, EARNING_FIELDS, DEDUCTION_FIELDS };
