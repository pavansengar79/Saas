"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const stub = (modulePath, exports) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

let savedLock;
let inheritedLock;
let populatedPaths;
const lockModel = {
  findOne: filter => ({
    then: (resolve, reject) => Promise.resolve(filter.isLocked && (filter.unit_id === null || filter.unit_id?.$in) ? inheritedLock : savedLock).then(resolve, reject),
    populate(path) {
      populatedPaths.push(path);
      return this;
    },
    async lean() { return filter.isLocked && (filter.unit_id === null || filter.unit_id?.$in) ? inheritedLock : savedLock; },
  }),
  async create(fields) {
    savedLock = { ...fields, async save() {} };
    return savedLock;
  },
};

stub("./models/payrollPeriodLock.model", lockModel);
stub("./models/payslip.model", { find: () => ({ async lean() { return []; } }) });
const lockService = require("./payrollLock.service");

test("lock, unlock and relock retain the period and action history", async () => {
  savedLock = null;
  populatedPaths = [];
  const user = {
    orgId: new mongoose.Types.ObjectId(),
    companyId: new mongoose.Types.ObjectId(),
    unitId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
  };
  const month = "2026-10";

  await lockService.lockPeriod({ month, reason: "Close attendance" }, user);
  assert.equal(savedLock.period, "Oct 2026");
  assert.equal(savedLock.month, 10);
  assert.equal(savedLock.year, 2026);
  assert.equal(savedLock.history[0].action, "LOCKED");
  assert.ok(savedLock.history[0].at instanceof Date);

  await lockService.unlockPeriod({ month, reason: "Correct attendance" }, user);
  await lockService.lockPeriod({ month, reason: "Corrections complete" }, user);
  const result = await lockService.getLockStatus(month, user);
  assert.equal(result.period, "Oct 2026");
  assert.deepEqual(result.history.map(entry => entry.action), ["LOCKED", "UNLOCKED", "LOCKED"]);
  assert.ok(result.history.every(entry => entry.at instanceof Date));
  assert.ok(populatedPaths.includes("history.by"));
});

test("status recognizes a company lock inherited by a unit", async () => {
  savedLock = null;
  inheritedLock = { isLocked: true, period: "Oct 2026", history: [] };
  populatedPaths = [];
  const user = {
    orgId: new mongoose.Types.ObjectId(),
    companyId: new mongoose.Types.ObjectId(),
    unitId: new mongoose.Types.ObjectId(),
  };

  try {
    const result = await lockService.getLockStatus("2026-10", user);
    assert.equal(result, inheritedLock);
    assert.equal(await lockService.isPeriodLocked(10, 2026, user.orgId, user.unitId, user.companyId), true);
  } finally {
    inheritedLock = null;
  }
});