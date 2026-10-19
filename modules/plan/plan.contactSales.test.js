"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const stub = (modulePath, exports) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const query = value => ({ select() { return this; }, populate() { return this; }, sort() { return this; }, limit() { return this; }, async lean() { return value; } });

const planId = new mongoose.Types.ObjectId();
let created = [];
let emails = [];
stub("./models/plan.model", { findOne: () => query({ _id: planId, name: "Enterprise" }) });
stub("./models/planQuoteRequest.model", {
  findOne: async () => created[0] || null,
  create: async doc => { const saved = { _id: new mongoose.Types.ObjectId(), status: "NEW", ...doc }; created.push(saved); return saved; },
});
stub("../auth/models/user.model", { findById: () => query({ name: "Asha", email: "asha@acme.in" }) });
stub("../../utils/email/email", { sendEmail: async mail => { emails.push(mail); } });
process.env.SALES_EMAIL = "sales@example.com";

const { contactSales } = require("./plan.service");
const user = { userId: new mongoose.Types.ObjectId(), orgId: new mongoose.Types.ObjectId() };

test("Request quote for Enterprise saves the request and emails sales (was 'Route not found')", async () => {
  const request = await contactSales({ planId: String(planId), billingCycle: "annual" }, user);
  assert.equal(request.status, "NEW");
  assert.equal(request.email, "asha@acme.in");
  assert.equal(emails[0].to, "sales@example.com");
  assert.match(emails[0].subject, /Enterprise \(annual\)/);
});

test("a second click does not create a duplicate open request", async () => {
  await contactSales({ planId: String(planId) }, user);
  assert.equal(created.length, 1);
});

test("planId is required", async () => {
  await assert.rejects(contactSales({}, user), /planId is required/);
});
