"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const servicePath = require.resolve("./payrollRun.service");
const payrollRunService = { runForTenant: async () => {} };
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: payrollRunService,
};
const { runForTenant } = require("./payrollRun.controller");

const request = {
  body: { month: "2026-10" },
  user: { companyId: "company", unitId: "unit", userId: "user" },
};

const runWithSummary = async (summary) => {
  payrollRunService.runForTenant = async () => ({ month: "2026-10", summary });
  const response = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await runForTenant(request, response, error => { throw error; });
  return response;
};

test("all employees blocked by run date returns the date as an error", async () => {
  const reason = "Payroll for this period can be run on or after day 28";
  const response = await runWithSummary({
    processed: 0,
    failed: 6,
    errors: Array.from({ length: 6 }, () => ({ error: reason })),
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, reason);
  assert.equal(response.body.data.summary.failed, 6);
});

test("different failures do not misrepresent one reason as the cause", async () => {
  const response = await runWithSummary({
    processed: 0,
    failed: 2,
    errors: [{ error: "Missing policy" }, { error: "Protected payslip" }],
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.message, "Payroll failed for all employees. Check individual errors.");
});

test("partially successful payroll keeps its result and counts", async () => {
  const response = await runWithSummary({
    processed: 1,
    failed: 1,
    errors: [{ error: "Missing policy" }],
  });

  assert.equal(response.statusCode, undefined);
  assert.equal(response.body.success, true);
  assert.match(response.body.message, /Processed: 1, Failed: 1/);
});