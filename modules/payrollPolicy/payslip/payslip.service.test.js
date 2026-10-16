"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const stub = (modulePath, exports) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const orgId = new mongoose.Types.ObjectId();
const companyId = new mongoose.Types.ObjectId();
const unitId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const user = { orgId, companyId, unitId, userId };
const query = value => ({ populate() { return value; } });
let drafts = [];
const listQuery = () => ({
  populate(_field, fields) { return fields === "name employeeId email salary" ? drafts : this; },
  sort() { return this; },
  skip() { return this; },
  limit() { return this; },
  async lean() { return drafts; },
});

stub("../payrollLock.service", { isPeriodLocked: async () => true });
stub("../models/payslip.model", {
  findOne: () => query(drafts[0]),
  find: listQuery,
  countDocuments: async () => drafts.length,
});
stub("../../company/models/company.model", {
  findById: () => ({ select() { return { lean: async () => ({}) }; } }),
});
stub("../../../utils/email/email", { sendEmail: async () => {} });

const { getAllPayslips, publishPayslip, publishAllPayslips } = require("./payslip.service");

const makeDraft = salary => ({
  _id: new mongoose.Types.ObjectId(),
  org_id: orgId,
  company_id: companyId,
  unit_id: unitId,
  employee_id: { _id: new mongoose.Types.ObjectId(), salary },
  earnings: { basic: salary.basic },
  year: 2026,
  month: 10,
  status: "DRAFT",
  async save() { this.saved = true; },
});

test("payslip list returns calendar payable days without changing saved scheduled days", async () => {
  drafts = [
    { ...makeDraft({ basic: 100000 }), daysPayable: 11, eligibleCalendarDays: 16, eligibleWorkingDays: 12 },
    { ...makeDraft({ basic: 100000 }), daysPayable: 5 },
  ];
  const result = await getAllPayslips({ month: 10, year: 2026 }, user);
  assert.equal(result.payslips[0].daysPayable, 11);
  assert.equal(result.payslips[0].payableOffDays, 4);
  assert.equal(result.payslips[0].payableCalendarDays, 15);
  assert.equal(result.payslips[1].payableCalendarDays, null);
  assert.equal(drafts[0].payableCalendarDays, undefined);
});

test("single publish rejects a prior draft when salary is not assigned", async () => {
  drafts = [makeDraft({ basic: 0, grossSalary: 0 })];
  await assert.rejects(publishPayslip(drafts[0]._id, user), /no assigned salary structure/);
  assert.equal(drafts[0].status, "DRAFT");
  assert.equal(drafts[0].saved, undefined);
});

test("single publish rejects stale zero earnings even after salary is assigned", async () => {
  drafts = [makeDraft({ basic: 100000 })];
  drafts[0].earnings.basic = 0;
  await assert.rejects(publishPayslip(drafts[0]._id, user), /no calculated salary earnings/);
  assert.equal(drafts[0].status, "DRAFT");
});

test("bulk publish skips missing salary but publishes an assigned salary draft", async () => {
  drafts = [makeDraft({ basic: 0 }), makeDraft({ basic: 100000 })];
  const result = await publishAllPayslips({ month: 10, year: 2026 }, user);
  assert.equal(result.summary.published, 1);
  assert.equal(result.summary.failed, 1);
  assert.match(result.summary.errors[0].error, /no assigned salary structure/);
  assert.equal(drafts[0].status, "DRAFT");
  assert.equal(drafts[1].status, "PUBLISHED");
});