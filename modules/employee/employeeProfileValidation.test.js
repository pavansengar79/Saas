"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { updateEmployeeSchema } = require("./employee.validation");

const opts = { allowUnknown: false, abortEarly: false };
const ID = "6ad889a35fba126676051e58";

test("E-02: saved experience/family rows with _id and blank fields are accepted", () => {
  const { error, value } = updateEmployeeSchema.validate({
    experience: [{ _id: ID, company: "Acme", role: "Dev", from: "2022-01-01", to: "", current: true }],
    familyDetails: [{ _id: ID, name: "Asha", relation: "Mother", dateOfBirth: "", phone: "" }],
    education: [{ _id: ID, institution: "DU", degree: "BSc", from: "", to: "" }],
  }, opts);
  assert.equal(error, undefined);
  assert.equal(value.experience[0].to, undefined);   // "" date is dropped, not stored
});

test("E-02: bank form with empty optional fields is accepted", () => {
  const { error } = updateEmployeeSchema.validate({
    bankDetails: { bankName: "SBI", accountNumber: "1234", ifscCode: "", branchName: "", accountType: "SAVINGS" },
  }, opts);
  assert.equal(error, undefined);
});

test("E-02: a bad sub-document id is still rejected", () => {
  const { error } = updateEmployeeSchema.validate({ experience: [{ _id: "not-an-id", company: "A" }] }, opts);
  assert.ok(error);
});
