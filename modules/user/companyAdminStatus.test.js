const assert = require('node:assert/strict');
const { test } = require('node:test');

const User = require('../auth/models/user.model');
const Role = require('../role/role.model');
const Employee = require('../employee/models/employee.model');
const { updateUser, deleteUser } = require('./user.service');
const { changeStatus, updateEmployee, deleteEmployee } = require('../employee/employee.service');
const { assertCompanyAdminDeactivationConfirmed } = require('../../utils/companyAdminStatusGuard');
const { updateUserSchema } = require('./user.validation');
const { updateEmployeeSchema } = require('../employee/employee.validation');

const original = {
  userFindById: User.findById,
  userFindOne: User.findOne,
  roleFindById: Role.findById,
  employeeFindOne: Employee.findOne,
};

function stubActiveCompanyAdmin() {
  User.findById = () => ({ select: () => ({ lean: async () => ({ status: 'ACTIVE', roleId: 'company-admin-role' }) }) });
  Role.findById = () => ({ select: () => ({ lean: async () => ({ slug: 'company_admin', level: 'company' }) }) });
}

function restore() {
  User.findById = original.userFindById;
  User.findOne = original.userFindOne;
  Role.findById = original.roleFindById;
  Employee.findOne = original.employeeFindOne;
}

test('company admin deactivation requires explicit confirmation; activation does not', async () => {
  stubActiveCompanyAdmin();
  try {
    await assert.rejects(
      assertCompanyAdminDeactivationConfirmed('admin-one', 'INACTIVE'),
      { statusCode: 400, message: /confirmCompanyAdminDeactivation/ }
    );
    await assertCompanyAdminDeactivationConfirmed('admin-one', 'INACTIVE', true);
    await assertCompanyAdminDeactivationConfirmed('admin-one', 'ACTIVE');
    assert.equal(updateUserSchema.validate({ status: 'INACTIVE', confirmCompanyAdminDeactivation: true }).error, undefined);
    assert.equal(updateEmployeeSchema.validate({ status: 'INACTIVE', confirmCompanyAdminDeactivation: true }).error, undefined);
    assert.ok(updateUserSchema.validate({ status: 'INACTIVE', confirmCompanyAdminDeactivation: 'true' }).error);
  } finally {
    restore();
  }
});

test('other roles can still change status without company admin confirmation', async () => {
  stubActiveCompanyAdmin();
  Role.findById = () => ({ select: () => ({ lean: async () => ({ slug: 'unit_admin' }) }) });
  try {
    await assertCompanyAdminDeactivationConfirmed('unit-admin', 'INACTIVE');
  } finally {
    restore();
  }
});

test('updating a company admin to inactive does not save without confirmation', async () => {
  stubActiveCompanyAdmin();
  let saved = false;
  User.findOne = async () => ({
    _id: { toString: () => 'admin-one' }, roleId: 'company-admin-role', status: 'ACTIVE',
    save: async () => { saved = true; },
  });
  try {
    await assert.rejects(
      updateUser('admin-one', { status: 'INACTIVE' }, { userId: 'other-admin', orgId: 'org-one', level: 'org' }),
      /confirmCompanyAdminDeactivation/
    );
    assert.equal(saved, false);
  } finally {
    restore();
  }
});

test('deleting a company admin does not save without confirmation', async () => {
  stubActiveCompanyAdmin();
  let saved = false;
  User.findOne = async () => ({
    _id: { toString: () => 'admin-one' }, roleId: 'company-admin-role', status: 'ACTIVE',
    save: async () => { saved = true; },
  });
  try {
    await assert.rejects(
      deleteUser('admin-one', { userId: 'other-admin', orgId: 'org-one', level: 'org' }),
      /confirmCompanyAdminDeactivation/
    );
    assert.equal(saved, false);
  } finally {
    restore();
  }
});

test('changing the linked employee status cannot silently disable a company admin', async () => {
  stubActiveCompanyAdmin();
  let saved = false;
  Employee.findOne = async () => ({
    _id: 'employee-one', userId: 'admin-one', status: 'ACTIVE',
    save: async () => { saved = true; },
  });
  try {
    await assert.rejects(
      changeStatus('employee-one', { status: 'INACTIVE' }, { userId: 'other-admin', orgId: 'org-one', level: 'org' }),
      /confirmCompanyAdminDeactivation/
    );
    assert.equal(saved, false);
  } finally {
    restore();
  }
});

test('updating or deleting a linked employee cannot silently disable a company admin', async () => {
  stubActiveCompanyAdmin();
  let saved = false;
  Employee.findOne = async () => ({
    _id: 'employee-one', userId: 'admin-one', status: 'INACTIVE',
    save: async () => { saved = true; },
  });
  const actor = { userId: 'other-admin', orgId: 'org-one', level: 'org' };
  try {
    // Even a same-status update would re-sync the linked User to INACTIVE.
    await assert.rejects(
      updateEmployee('employee-one', { status: 'INACTIVE' }, actor),
      /confirmCompanyAdminDeactivation/
    );
    await assert.rejects(
      deleteEmployee('employee-one', actor),
      /confirmCompanyAdminDeactivation/
    );
    assert.equal(saved, false);
  } finally {
    restore();
  }
});
