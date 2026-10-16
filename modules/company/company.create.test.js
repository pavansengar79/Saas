const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');

const Company = require('./models/company.model');
const OrgModule = require('../orgModule/models/orgModule.model');
const User = require('../auth/models/user.model');
const email = require('../../utils/email/email');
const leaveSeeders = require('../../seeders/leave.Seeders');

// Capture side-effect spies before the service is imported.
const originalEmail = email.sendEmail;
const originalSeeder = leaveSeeders.seedLeaveTypes;
let emailCalls = 0;
let seedCalls = 0;
email.sendEmail = async () => { emailCalls++; };
leaveSeeders.seedLeaveTypes = async () => { seedCalls++; };
const controller = require('./company.controller');
email.sendEmail = originalEmail;
leaveSeeders.seedLeaveTypes = originalSeeder;

test('creating a company does not invite an admin or claim credentials were emailed', async () => {
  const original = {
    startSession: mongoose.startSession,
    companyFindOne: Company.findOne,
    companyCreate: Company.create,
    orgModuleFind: OrgModule.find,
    userCreate: User.create,
  };
  let committed = false;
  let createdCompany;

  try {
    mongoose.startSession = async () => ({
      startTransaction() {},
      async commitTransaction() { committed = true; },
      async abortTransaction() { assert.fail('Company creation should not abort'); },
      endSession() {},
    });
    Company.findOne = (filter) => {
      if (filter.company_name) return { collation: async () => null };
      return Promise.resolve(null);
    };
    Company.create = async ([data]) => {
      createdCompany = { _id: 'company-one', ...data };
      return [createdCompany];
    };
    OrgModule.find = () => ({ lean: async () => [] });
    User.create = async () => assert.fail('Company creation must not create an admin user');

    const response = {
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await controller.createCompany({
      body: {
        company_name: 'Example Company',
        company_email: 'company@example.com',
        company_phone: '1234567890',
        admin: 'uninvited-user',
      },
      user: { orgId: 'org-one', userId: 'org-admin' },
    }, response, (error) => { throw error; });

    assert.equal(committed, true);
    assert.equal(seedCalls, 1);
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.success, true);
    assert.match(response.body.message, /Company created successfully/);
    assert.match(response.body.message, /No admin has been invited/);
    assert.equal(response.body.data.message, response.body.message);
    assert.equal(response.body.data.adminInvited, false);
    assert.equal(response.body.data.company.admin, null);
    assert.equal(createdCompany.company_name_key, 'example company');
    assert.equal(emailCalls, 0);
  } finally {
    mongoose.startSession = original.startSession;
    Company.findOne = original.companyFindOne;
    Company.create = original.companyCreate;
    OrgModule.find = original.orgModuleFind;
    User.create = original.userCreate;
  }
});
