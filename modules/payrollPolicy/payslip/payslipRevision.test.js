"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { applyPayslipRevision } = require("./payslipRevision");

const makePayslip = (status = "PUBLISHED") => ({
  status,
  earnings: { basic: 30000, hra: 12000, travelAllowance: 0, medicalAllowance: 0, specialAllowance: 8000, overtime: 0, bonus: 0, arrears: 0 },
  deductions: { pf: 3000, esi: 0, tds: 2000, lop: 1000, professionalTax: 200, advance: 0, other: 0 },
  grossSalary: 50000,
  grossAfterLOP: 49000,
  netSalary: 43800,
  revisionHistory: [],
});

test("P0-7 revision recomputes gross and net and keeps an audit trail", () => {
  const payslip = applyPayslipRevision(makePayslip("PAID"), {
    reason: "Missed festival bonus for October",
    earnings: { bonus: 5000 },
    deductions: { tds: 2500 },
  }, "user-1");

  assert.equal(payslip.status, "PAID");
  assert.equal(payslip.grossSalary, 55000);
  assert.equal(payslip.grossAfterLOP, 54000);
  assert.equal(payslip.netSalary, 48300);
  assert.equal(payslip.isRevised, true);
  assert.equal(payslip.revisionCount, 1);
  assert.equal(payslip.revisionHistory[0].oldValues.netSalary, 43800);
  assert.equal(payslip.revisionHistory[0].newValues.netSalary, 48300);
  assert.equal(payslip.revisionHistory[0].revisedBy, "user-1");
});

test("P0-7 DRAFT payslips cannot be revised", () => {
  assert.throws(() => applyPayslipRevision(makePayslip("DRAFT"), { reason: "long enough reason", earnings: { bonus: 1 } }), /PUBLISHED or PAID/);
});

test("P0-7 reason, fields and amounts are validated", () => {
  assert.throws(() => applyPayslipRevision(makePayslip(), { reason: "short", earnings: { bonus: 1 } }), /at least 10/);
  assert.throws(() => applyPayslipRevision(makePayslip(), { reason: "valid reason here", earnings: { salary: 1 } }), /cannot be revised/);
  assert.throws(() => applyPayslipRevision(makePayslip(), { reason: "valid reason here", deductions: { tds: -5 } }), /0 or more/);
  assert.throws(() => applyPayslipRevision(makePayslip(), { reason: "valid reason here" }), /Nothing to revise/);
  assert.throws(() => applyPayslipRevision(makePayslip(), { reason: "valid reason here", deductions: { other: 60000 } }), /cannot be more/);
});
