const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const Company = require('./models/company.model');
const OrgModule = require('../orgModule/models/orgModule.model');
const leaveSeeders = require('../../seeders/leave.Seeders');
const originalSeed = leaveSeeders.seedLeaveTypes;
leaveSeeders.seedLeaveTypes = async () => {};
const { createCompany, updateCompany } = require('./company.service');
leaveSeeders.seedLeaveTypes = originalSeed;
const { normalizeCompanyName, legacyNamePattern } = require('./companyName');

const original = {
  findOne: Company.findOne,
  findOneAndUpdate: Company.findOneAndUpdate,
  create: Company.create,
  orgModuleFind: OrgModule.find,
  startSession: mongoose.startSession,
};
const user = { orgId: 'org-one', userId: 'admin-one' };
const payload = (name = 'Acme  Ltd') => ({
  company_name: name, company_email: 'company@example.com', company_phone: '1234567890',
});

function restore() {
  Company.findOne = original.findOne;
  Company.findOneAndUpdate = original.findOneAndUpdate;
  Company.create = original.create;
  OrgModule.find = original.orgModuleFind;
  mongoose.startSession = original.startSession;
}

test('company names normalize case, Unicode and whitespace; index is scoped to active companies', async () => {
  assert.equal(normalizeCompanyName('  ACME\tLtd  '), 'acme ltd');
  assert.equal(normalizeCompanyName('ＡＣＭＥ Ltd'), 'acme ltd');
  assert.match('  aCmE   LTD  ', new RegExp(legacyNamePattern('Acme Ltd'), 'i'));
  assert.doesNotMatch('Acme (Ltd) Other', new RegExp(legacyNamePattern('Acme (Ltd)'), 'i'));

  const index = Company.schema.indexes().find(([, options]) => options.name === 'unique_active_company_name_per_org');
  assert.deepEqual(index[0], { org_id: 1, company_name_key: 1 });
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, {
    is_deleted: false, company_name_key: { $type: 'string' },
  });

  const company = new Company({
    org_id: new mongoose.Types.ObjectId(), company_code: 'ACME-1234',
    company_name: '  Acme  LTD  ', company_email: 'company@example.com', company_phone: '1234567890',
  });
  await company.validate();
  assert.equal(company.company_name_key, 'acme ltd');
});

test('create rejects existing active name even if old record has no name key', async () => {
  let sessionStarted = false;
  try {
    Company.findOne = (filter) => {
      if (filter.company_email) return Promise.resolve(null);
      assert.equal(filter.org_id, 'org-one');
      assert.equal(filter.is_deleted, false);
      assert.equal(filter.$or[0].company_name_key, 'acme ltd');
      assert.match('  ACME  ltd  ', new RegExp(filter.$or[1].company_name.$regex, 'i'));
      return Promise.resolve({ company_name: 'Acme Ltd' });
    };
    mongoose.startSession = async () => { sessionStarted = true; throw new Error('must not start session'); };
    await assert.rejects(createCompany(payload(' ACME\tLTD '), user), {
      statusCode: 409, message: 'A company with this name already exists',
    });
    assert.equal(sessionStarted, false);
  } finally { restore(); }
});

test('create scopes the name and the saved company to the authenticated org', async () => {
  try {
    Company.findOne = async (filter) => {
      if (filter.$or) {
        assert.equal(filter.org_id, 'org-two');
        assert.equal(filter.is_deleted, false);
      }
      return null; // Existing Acme Ltd belongs to org-one, not org-two.
    };
    mongoose.startSession = async () => ({
      startTransaction() {},
      async commitTransaction() {},
      async abortTransaction() {},
      endSession() {},
    });
    Company.create = async ([data]) => [{ _id: 'company-new', ...data }];
    OrgModule.find = () => ({ lean: async () => [] });
    const result = await createCompany({
      ...payload('ACME LTD'), org_id: 'org-one', is_deleted: true,
      company_name_key: 'forged',
    }, { ...user, orgId: 'org-two' });
    assert.equal(result.company.org_id, 'org-two');
    assert.equal(result.company.is_deleted, false);
    assert.equal(result.company.company_name_key, 'acme ltd');
  } finally { restore(); }
});

test('create catches concurrent name collisions via the unique index', async () => {
  let aborted = false;
  try {
    Company.findOne = async (filter) => {
      if (filter.$or) assert.equal(filter.org_id, 'org-two');
      return null;
    };
    mongoose.startSession = async () => ({
      startTransaction() {},
      async commitTransaction() {},
      async abortTransaction() { aborted = true; },
      endSession() {},
    });
    Company.create = async ([data]) => {
      assert.equal(data.company_name_key, 'acme ltd');
      throw { code: 11000, keyPattern: { org_id: 1, company_name_key: 1 } };
    };
    await assert.rejects(createCompany(payload(), { ...user, orgId: 'org-two' }), {
      statusCode: 409, message: 'A company with this name already exists',
    });
    assert.equal(aborted, true);
  } finally { restore(); }
});

test('rename rejects another company name in the same org', async () => {
  try {
    Company.findOne = (filter) => {
      if (!filter.$or) return { select: () => ({ lean: async () => ({ company_name: 'Old Company' }) }) };
      assert.deepEqual(filter._id, { $ne: 'company-one' });
      assert.equal(filter.org_id, 'org-one');
      assert.equal(filter.$or[0].company_name_key, 'acme ltd');
      return Promise.resolve({ _id: 'company-two' });
    };
    Company.findOneAndUpdate = async () => assert.fail('Must not update a duplicate name');
    await assert.rejects(updateCompany('company-one', { company_name: ' ACME Ltd ' }, user), {
      statusCode: 409, message: 'A company with this name already exists',
    });
  } finally { restore(); }
});

test('rename saves normalized key, excludes itself and handles unique-index race', async () => {
  try {
    Company.findOne = (filter) => {
      if (!filter.$or) return { select: () => ({ lean: async () => ({ company_name: 'Old Company' }) }) };
      assert.deepEqual(filter._id, { $ne: 'company-one' });
      return Promise.resolve(null);
    };
    Company.findOneAndUpdate = async (filter, update) => {
      assert.equal(filter.org_id, 'org-one');
      assert.equal(update.company_name_key, 'acme ltd');
      return { _id: 'company-one', ...update };
    };
    const result = await updateCompany('company-one', {
      company_name: '  ACME  Ltd ', company_name_key: 'forged',
    }, user);
    assert.equal(result.company_name_key, 'acme ltd');

    Company.findOneAndUpdate = async () => { throw { code: 11000, keyPattern: { company_name_key: 1 } }; };
    await assert.rejects(updateCompany('company-one', { company_name: 'Acme Ltd' }, user), {
      statusCode: 409, message: 'A company with this name already exists',
    });
  } finally { restore(); }
});

test('legacy duplicates can save their unchanged name and profile without claiming a key', async () => {
  try {
    Company.findOne = (filter) => {
      assert.equal(filter._id, 'company-one');
      return { select: () => ({ lean: async () => ({ company_name: 'Acme Ltd' }) }) };
    };
    Company.findOneAndUpdate = async (filter, update) => {
      assert.equal(filter.company_name, 'Acme Ltd');
      assert.equal(filter.company_name_key, null);
      assert.equal(update.company_name_key, undefined);
      assert.equal(update.company_phone, '1111111111');
      return { _id: 'company-one', ...update };
    };
    const result = await updateCompany('company-one', {
      company_name: ' ACME  Ltd ', company_phone: '1111111111', company_name_key: 'forged',
    }, user);
    assert.equal(result.company_phone, '1111111111');
  } finally { restore(); }
});

test('already-keyed company keeps its name key when updating capitalization', async () => {
  try {
    Company.findOne = () => ({ select: () => ({
      lean: async () => ({ company_name: 'Acme Ltd', company_name_key: 'acme ltd' }),
    }) });
    Company.findOneAndUpdate = async (filter, update) => {
      assert.equal(filter.company_name_key, undefined);
      assert.equal(update.company_name_key, 'acme ltd');
      return update;
    };
    await updateCompany('company-one', { company_name: 'ACME LTD' }, user);
  } finally { restore(); }
});

test('create and rename reject blank names', async () => {
  await assert.rejects(createCompany(payload(' \t '), user), { statusCode: 400 });
  await assert.rejects(updateCompany('company-one', { company_name: '  ' }, user), { statusCode: 400 });
});
