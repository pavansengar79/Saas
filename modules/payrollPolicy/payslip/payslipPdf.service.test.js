"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { renderPayslipPdf } = require("./payslipPdf.service");

test("renders a standards-compliant payslip PDF", async () => {
  const buffer = await renderPayslipPdf({
    month: 3,
    year: 2026,
    status: "PUBLISHED",
    employee_id: { name: "Test Employee", employeeId: "EMP-1", email: "employee@example.com" },
    earnings: { basic: 20800, hra: 5000, overtime: 2000 },
    deductions: { pf: 1800, esi: 0, tds: 500, lop: 0 },
    overtimeHours: 10,
    overtimeMultiplier: 2,
    grossSalary: 27800,
    grossAfterLOP: 27800,
    netSalary: 25500,
    actualPayableDays: 31,
    totalWorkingDays: 22,
    eligibleWorkingDays: 22,
    daysPresent: 22,
    lopDays: 0,
    daysPayable: 22,
  });

  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  assert.ok(buffer.length > 1000);
});
test("PF-1 payslip PDF lists custom components", async () => {
  const buffer = await renderPayslipPdf({
    month: 10, year: 2026, status: "PUBLISHED",
    employee_id: { name: "Test Employee", employeeId: "EMP-1", email: "employee@example.com" },
    earnings: { basic: 20000, hra: 8000, customComponents: [{ code: "DA", name: "Dearness allowance", amount: 5000 }] },
    deductions: { pf: 3000, esi: 0, tds: 0, lop: 0 },
    grossSalary: 33000, grossAfterLOP: 33000, netSalary: 30000,
  });
  const text = buffer.toString("latin1");
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  assert.ok(buffer.length > 1000);
  // pdfkit encodes text, so compare against the same payslip without the component: one extra row
  const without = await renderPayslipPdf({
    month: 10, year: 2026, status: "PUBLISHED",
    employee_id: { name: "Test Employee", employeeId: "EMP-1", email: "employee@example.com" },
    earnings: { basic: 20000, hra: 8000 },
    deductions: { pf: 3000, esi: 0, tds: 0, lop: 0 },
    grossSalary: 28000, grossAfterLOP: 28000, netSalary: 25000,
  });
  assert.ok(text.length > without.toString("latin1").length);
});
