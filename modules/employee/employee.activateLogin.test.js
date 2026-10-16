const assert = require('node:assert/strict');
const { test } = require('node:test');

const Employee = require('./models/employee.model');
const User = require('../auth/models/user.model');
const Role = require('../role/role.model');
const Subscription = require('../subscription/models/subscription.Models');
const Module = require('../module/models/module.model');
const email = require('../../utils/email/email');

const sendEmail = email.sendEmail;
email.sendEmail = async () => {};
const { activateLogin } = require('./employee.service');
email.sendEmail = sendEmail;

const actor = { orgId: 'org-one', level: 'org', userId: 'org-admin' };
const employee = () => ({
  _id: 'employee-one', org_id: 'org-one', company_id: 'company-one',
  unit_id: 'unit-one', name: 'Test Employee', email: 'test@example.com',
  phone: '1234567890', status: 'INACTIVE',
  async save() {},
});

function stubBasics(t, modules, assignedRole = 'company') {
  const record = employee();
  let created = 0;
  t.mock.method(Employee, 'findOne', async filter => {
    assert.equal(filter.org_id, 'org-one');
    return record;
  });
  t.mock.method(Role, 'findOne', async filter => {
    assert.equal(filter.$or[0].org_id, 'org-one');
    return { _id: 'requested-role', level: assignedRole, name: 'Company Admin' };
  });
  t.mock.method(Subscription, 'findOne', filter => {
    assert.deepEqual(filter, { org_id: 'org-one', is_active: true });
    return { select: () => ({ lean: async () => ({ plan_snapshot: { structure_level: 'enterprise', modules } }) }) };
  });
  t.mock.method(Module, 'findOne', () => ({ select: () => ({ lean: async () => ({ _id: 'module-id' }) }) }));
  t.mock.method(User, 'create', async data => { created++; return { _id: 'new-user', ...data }; });
  return { record, getCreated: () => created };
}

test('employee login activation cannot create a company admin without company management', async t => {
  const state = stubBasics(t, ['employee']);
  t.mock.method(User, 'findOne', async () => null);
  await assert.rejects(
    activateLogin('employee-one', { roleId: 'requested-role' }, actor),
    { statusCode: 403, message: /does not include company management/ }
  );
  assert.equal(state.getCreated(), 0);
  assert.equal(state.record.status, 'INACTIVE');
});

test('employee login activation rejects company roles without a purchased module even on reactivation', async t => {
  const state = stubBasics(t, []);
  const existingUser = { status: 'INACTIVE', save: async () => assert.fail('User must not be reactivated') };
  t.mock.method(User, 'findOne', async () => existingUser);
  await assert.rejects(
    activateLogin('employee-one', { roleId: 'requested-role' }, actor),
    { statusCode: 403 }
  );
  assert.equal(existingUser.status, 'INACTIVE');
  assert.equal(state.record.status, 'INACTIVE');
});

test('reactivation cannot bypass the gate by requesting an employee role for an existing company admin', async t => {
  const state = stubBasics(t, ['employee'], 'unit');
  const existingUser = { roleId: 'company-admin-role', status: 'INACTIVE', save: async () => assert.fail('User must not be reactivated') };
  t.mock.method(User, 'findOne', async () => existingUser);
  t.mock.method(Role, 'findById', () => ({ select: () => ({ lean: async () => ({ level: 'company' }) }) }));
  await assert.rejects(
    activateLogin('employee-one', { roleId: 'requested-role' }, actor),
    { statusCode: 403, message: /does not include company management/ }
  );
  assert.equal(existingUser.status, 'INACTIVE');
  assert.equal(state.record.status, 'INACTIVE');
});

test('employee login activation accepts a legacy organisation module ID', async t => {
  const state = stubBasics(t, ['module-id']);
  t.mock.method(User, 'findOne', async () => null);
  const result = await activateLogin('employee-one', { roleId: 'requested-role' }, actor);
  assert.equal(result.user.role, 'Company Admin');
  assert.equal(state.getCreated(), 1);
  assert.equal(state.record.status, 'ACTIVE');
});

test('employee login activation accepts a purchased organisation slug', async t => {
  const state = stubBasics(t, ['organisation']);
  t.mock.method(User, 'findOne', async () => null);
  await activateLogin('employee-one', { roleId: 'requested-role' }, actor);
  assert.equal(state.getCreated(), 1);
});

test('unit-level login activation does not require company management', async t => {
  const state = stubBasics(t, [], 'unit');
  t.mock.method(User, 'findOne', async () => null);
  t.mock.method(Subscription, 'findOne', () => assert.fail('Unit roles do not need company management'));
  await activateLogin('employee-one', { roleId: 'requested-role' }, actor);
  assert.equal(state.getCreated(), 1);
});