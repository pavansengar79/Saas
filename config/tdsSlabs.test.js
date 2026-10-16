"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { calculateTDSNewRegime, compareTaxRegimes } = require("./tdsSlabs");

test("new regime gives the full rebate at twelve lakh taxable income", () => {
  const result = calculateTDSNewRegime(1200000);
  assert.equal(result.totalTax, 0);
  assert.equal(result.rebate87A, 60000);
});

test("new regime marginal relief limits tax just above twelve lakh", () => {
  const result = calculateTDSNewRegime(1200100);
  assert.equal(result.taxAfterRebate, 100);
  assert.equal(result.totalTax, 104);
  assert.equal(result.monthlyTDS, 9);
});

test("comparison applies the new-regime standard deduction once", () => {
  const result = compareTaxRegimes(1275000);
  assert.equal(result.newRegime.taxableIncome, 1200000);
  assert.equal(result.newRegime.totalTax, 0);
});