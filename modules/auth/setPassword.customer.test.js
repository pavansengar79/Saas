"use strict";
const test = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");
const Customer = require("../customer/models/customer.model");
const service = require("./auth.setPassword.service");
const controller = require("./auth.setPassword.controller");

const stubCustomer = (doc) => {
  const original = Customer.findOne;
  Customer.findOne = () => ({ select: async () => doc });
  return () => { Customer.findOne = original; };
};

test("A-03: customer token (no userId) can set its first-login password", async () => {
  const doc = { password: await bcrypt.hash("Temp@1234", 4), is_first_login: true, saved: false };
  doc.save = async () => { doc.saved = true; };
  const restore = stubCustomer(doc);
  try {
    let body;
    const res = { status: () => ({ json: (b) => { body = b; } }) };
    await controller.setPassword(
      { body: { newPassword: "NewPass@123" }, user: { userId: null, role: "customer", customerId: "c1" } },
      res, (e) => { throw e; }
    );
    assert.equal(body.success, true);
    assert.equal(doc.saved, true);
    assert.equal(doc.is_first_login, false);
    assert.equal(await bcrypt.compare("NewPass@123", doc.password), true);
  } finally { restore(); }
});

test("A-03: customer cannot reuse the temporary password or set it twice", async () => {
  const doc = { password: await bcrypt.hash("Temp@1234", 4), is_first_login: true, save: async () => {} };
  let restore = stubCustomer(doc);
  try {
    await assert.rejects(service.setCustomerPassword("c1", "Temp@1234"), /different/);
  } finally { restore(); }
  restore = stubCustomer({ ...doc, is_first_login: false });
  try {
    await assert.rejects(service.setCustomerPassword("c1", "NewPass@123"), /already been set/);
  } finally { restore(); }
});
