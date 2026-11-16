"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const migrateDesignationIndexes = require("./dropDesignationNameIndex");

const withFakeDb = async (collection, fn) => {
  const original = Object.getOwnPropertyDescriptor(mongoose.connection, "db");
  Object.defineProperty(mongoose.connection, "db", { configurable: true, get: () => ({ collection: () => collection }) });
  try { await fn(); } finally {
    if (original) Object.defineProperty(mongoose.connection, "db", original);
    else delete mongoose.connection.db;
  }
};

test("designation index migration works on a new database with no designations collection", async () => {
  const created = [];
  const collection = {
    indexes: async () => { const err = new Error("ns does not exist: HRMS_SAAS.designations"); err.code = 26; err.codeName = "NamespaceNotFound"; throw err; },
    dropIndex: async () => { throw new Error("must not drop"); },
    createIndex: async (key, options) => { created.push({ key, options }); },
  };
  await withFakeDb(collection, () => migrateDesignationIndexes());
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].key, { unit_id: 1, name: 1 });
});

test("designation index migration still reports other database errors", async () => {
  const collection = {
    indexes: async () => { const err = new Error("not authorized"); err.code = 13; throw err; },
    createIndex: async () => {},
  };
  await assert.rejects(withFakeDb(collection, () => migrateDesignationIndexes()), /not authorized/);
});