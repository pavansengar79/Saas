const assert = require('node:assert/strict');
const { test } = require('node:test');
const Role = require('./role.model');
const Permission = require('../permission/permission.model');
const Subscription = require('../subscription/models/subscription.Models');
const { createRole } = require('./role.service');

test('org admin cannot create a company-level role without company management', async t => {
  t.mock.method(Subscription, 'findOne', () => ({
    select: () => ({ lean: async () => ({ plan_snapshot: { structure_level: 'enterprise', modules: [] } }) }),
  }));
  t.mock.method(Role, 'create', async () => assert.fail('Role must not be created'));
  await assert.rejects(
    createRole({ name: 'Company Admin', level: 'company', permissions: [] }, { orgId: 'org-one', level: 'org' }),
    { statusCode: 403, message: /does not include company management/ }
  );
});

test('org admin can create a company-level role with purchased organisation module', async t => {
  t.mock.method(Subscription, 'findOne', () => ({
    select: () => ({ lean: async () => ({ plan_snapshot: { modules: ['organisation'] } }) }),
  }));
  t.mock.method(Role, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  t.mock.method(Role, 'distinct', async () => []);
  t.mock.method(Permission, 'find', async () => []);
  t.mock.method(Role, 'create', async data => ({ _id: 'custom-role', ...data }));
  t.mock.method(Role, 'findById', () => ({ populate: async () => ({ _id: 'custom-role' }) }));
  const result = await createRole(
    { name: 'Regional Admin', level: 'company', permissions: [] },
    { orgId: 'org-one', level: 'org', userId: 'org-admin' }
  );
  assert.equal(result._id, 'custom-role');
});