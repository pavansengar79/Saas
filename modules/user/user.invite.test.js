const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');

const User = require('../auth/models/user.model');
const Role = require('../role/role.model');
const Company = require('../company/models/company.model');
const Subscription = require('../subscription/models/subscription.Models');
const Module = require('../module/models/module.model');
const email = require('../../utils/email/email');

// The service captures sendEmail at import time; keep invitations entirely offline.
const originalSendEmail = email.sendEmail;
email.sendEmail = async () => {};
const { inviteUser, updateUser } = require('./user.service');
email.sendEmail = originalSendEmail;

const original = {
  startSession: mongoose.startSession,
  userFindOne: User.findOne,
  userCreate: User.create,
  userFindById: User.findById,
  userFindByIdAndUpdate: User.findByIdAndUpdate,
  userUpdateOne: User.updateOne,
  userUpdateMany: User.updateMany,
  roleFindOne: Role.findOne,
  roleFindById: Role.findById,
  companyFindOne: Company.findOne,
  companyUpdateOne: Company.updateOne,
  companyFindById: Company.findById,
  subscriptionFindOne: Subscription.findOne,
  moduleFindOne: Module.findOne,
};

function stubInvitation(existingAdmin = 'original-admin', planSnapshot = { structure_level: 'enterprise', modules: ['organisation'] }) {
  let admin = existingAdmin;
  const originalAdminUser = { _id: existingAdmin, status: 'ACTIVE' };
  let companyUpdates = 0;
  let userCreates = 0;
  const session = {
    startTransaction() {},
    async commitTransaction() {},
    async abortTransaction() {},
    endSession() {},
  };

  mongoose.startSession = async () => session;
  User.findOne = () => ({ session: async () => null });
  // An invitation must never inactivate an existing account through another
  // User update while it creates the new admin.
  User.findByIdAndUpdate = async () => assert.fail('Invitation must not update existing users');
  User.updateOne = async () => assert.fail('Invitation must not update existing users');
  User.updateMany = async () => assert.fail('Invitation must not update existing users');
  Role.findOne = () => ({
    select: () => ({ session: async () => ({ name: 'Company Admin', slug: 'company_admin', level: 'company' }) }),
  });
  Company.findOne = (filter) => {
    assert.equal(filter._id, 'company-one');
    assert.equal(filter.org_id, 'org-one');
    return { select: () => ({ session: async () => ({ _id: 'company-one' }) }) };
  };
  Subscription.findOne = () => ({
    select() { return this; },
    session() { return this; },
    lean: async () => ({ plan_snapshot: planSnapshot }),
  });
  Module.findOne = () => ({ select: () => ({ lean: async () => ({ _id: 'organisation-module-id' }) }) });
  User.create = async ([data]) => {
    userCreates++;
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.company_id, 'company-one');
    assert.equal(data.unit_id, null);
    return [{ ...data, _id: 'new-admin' }];
  };
  Company.updateOne = async (filter, update, options) => {
    companyUpdates++;
    assert.equal(filter.admin, null);
    assert.equal(filter._id, 'company-one');
    assert.equal(filter.org_id, 'org-one');
    assert.equal(options.session, session);
    if (admin == null) admin = update.$set.admin;
  };
  Company.findById = () => ({ select: async () => ({ company_name: 'Example Company' }) });
  User.findById = () => ({
    populate() { return this; },
    lean: async () => ({ _id: 'new-admin', status: 'ACTIVE' }),
  });

  return {
    getAdmin: () => admin,
    getOriginalAdminStatus: () => originalAdminUser.status,
    getCompanyUpdates: () => companyUpdates,
    getUserCreates: () => userCreates,
  };
}

function restore() {
  mongoose.startSession = original.startSession;
  User.findOne = original.userFindOne;
  User.create = original.userCreate;
  User.findById = original.userFindById;
  User.findByIdAndUpdate = original.userFindByIdAndUpdate;
  User.updateOne = original.userUpdateOne;
  User.updateMany = original.userUpdateMany;
  Role.findOne = original.roleFindOne;
  Role.findById = original.roleFindById;
  Company.findOne = original.companyFindOne;
  Company.updateOne = original.companyUpdateOne;
  Company.findById = original.companyFindById;
  Subscription.findOne = original.subscriptionFindOne;
  Module.findOne = original.moduleFindOne;
}

test('inviting another company admin preserves the existing primary admin', async () => {
  const state = stubInvitation();
  try {
    const result = await inviteUser(
      { email: 'new@example.com', roleId: 'company-admin-role' },
      { level: 'company', orgId: 'org-one', companyId: 'company-one', userId: 'original-admin' }
    );

    assert.equal(state.getAdmin(), 'original-admin');
    assert.equal(state.getOriginalAdminStatus(), 'ACTIVE');
    assert.equal(state.getCompanyUpdates(), 1);
    assert.equal(state.getUserCreates(), 1);
    assert.equal(result.user.status, 'ACTIVE');
  } finally {
    restore();
  }
});

test('first company admin invitation fills an empty primary admin slot', async () => {
  const state = stubInvitation(null);
  try {
    await inviteUser(
      { email: 'first@example.com', roleId: 'company-admin-role', company_id: 'company-one' },
      { level: 'org', orgId: 'org-one', userId: 'org-admin' }
    );
    assert.equal(state.getAdmin(), 'new-admin');
  } finally {
    restore();
  }
});

test('company admin invitations without a company are rejected', async () => {
  const state = stubInvitation();
  try {
    await assert.rejects(
      inviteUser(
        { email: 'new@example.com', roleId: 'company-admin-role' },
        { level: 'org', orgId: 'org-one', userId: 'org-admin' }
      ),
      /A company is required/
    );
    assert.equal(state.getUserCreates(), 0);
    assert.equal(state.getCompanyUpdates(), 0);
  } finally {
    restore();
  }
});

test('company admins cannot invite users into another company', async () => {
  const state = stubInvitation();
  try {
    await assert.rejects(
      inviteUser(
        { email: 'new@example.com', roleId: 'company-admin-role', company_id: 'company-two' },
        { level: 'company', orgId: 'org-one', companyId: 'company-one', userId: 'original-admin' }
      ),
      /cannot invite users to another company/
    );
    assert.equal(state.getUserCreates(), 0);
    assert.equal(state.getCompanyUpdates(), 0);
  } finally {
    restore();
  }
});

test('enterprise structure without company management cannot invite a company admin', async () => {
  const state = stubInvitation(null, { structure_level: 'enterprise', modules: ['employee', 'auth'] });
  try {
    await assert.rejects(
      inviteUser(
        { email: 'new@example.com', roleId: 'company-admin-role', company_id: 'company-one' },
        { level: 'org', orgId: 'org-one', userId: 'org-admin' }
      ),
      { statusCode: 403, message: /does not include company management/ }
    );
    assert.equal(state.getUserCreates(), 0);
    assert.equal(state.getCompanyUpdates(), 0);
  } finally {
    restore();
  }
});

test('a plan without company management rejects company-admin invitations even when company_id is omitted', async () => {
  const state = stubInvitation(null, { structure_level: 'enterprise', modules: [] });
  try {
    await assert.rejects(
      inviteUser(
        { email: 'new@example.com', roleId: 'company-admin-role' },
        { level: 'org', orgId: 'org-one', userId: 'org-admin' }
      ),
      { statusCode: 403, message: /does not include company management/ }
    );
    assert.equal(state.getUserCreates(), 0);
  } finally {
    restore();
  }
});

test('company admin invitation accepts the organisation module as an ObjectId in an older snapshot', async () => {
  const state = stubInvitation(null, { structure_level: 'company', modules: ['organisation-module-id'] });
  try {
    await inviteUser(
      { email: 'new@example.com', roleId: 'company-admin-role', company_id: 'company-one' },
      { level: 'org', orgId: 'org-one', userId: 'org-admin' }
    );
    assert.equal(state.getUserCreates(), 1);
  } finally {
    restore();
  }
});

test('role updates cannot assign company admin on a plan without company management', async () => {
  const state = stubInvitation(null, { structure_level: 'enterprise', modules: ['employee'] });
  try {
    const target = { _id: 'target', roleId: 'old-company-role', status: 'ACTIVE', save: async () => {
      assert.fail('Role must not be saved without company management');
    } };
    User.findOne = async () => target;
    Role.findById = (id) => ({ select: () => ({ lean: async () => ({ level: 'company', slug: id === 'company-admin-role' ? 'company_admin' : 'company_hr_manager' }) }) });

    await assert.rejects(
      updateUser('target', { roleId: 'company-admin-role' }, { level: 'org', orgId: 'org-one', userId: 'org-admin' }),
      { statusCode: 403, message: /does not include company management/ }
    );
    assert.equal(target.roleId, 'old-company-role');
    assert.equal(state.getUserCreates(), 0);
  } finally {
    restore();
  }
});