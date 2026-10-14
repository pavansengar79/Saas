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