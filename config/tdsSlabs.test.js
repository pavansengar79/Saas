"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { calculateTDSNewRegime, calculateTDSOldRegime, compareTaxRegimes } = require("./tdsSlabs");

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


test("#13: old-regime slabs start exactly at 2.5L / 5L / 10L (no ₹1 gap)", () => {
  // Tax before rebate and cess, per Income-tax Act old-regime slabs.
  assert.equal(calculateTDSOldRegime(600000).grossTax, 32500);
  assert.equal(calculateTDSOldRegime(1200000).grossTax, 172500);
  assert.equal(calculateTDSOldRegime(2000000).grossTax, 412500);
  assert.equal(calculateTDSOldRegime(1000000).grossTax, 112500);
});

test("#13: senior and super-senior old-regime slabs have no ₹1 gap", () => {
  assert.equal(calculateTDSOldRegime(600000, "senior").grossTax, 30000);
  assert.equal(calculateTDSOldRegime(1200000, "senior").grossTax, 170000);
  assert.equal(calculateTDSOldRegime(1200000, "super_senior").grossTax, 160000);
  assert.equal(calculateTDSOldRegime(2000000, "super_senior").grossTax, 400000);
});