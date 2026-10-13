const assert = require('node:assert/strict');
const { test } = require('node:test');

const User = require('./models/user.model');
const Employee = require('../employee/models/employee.model');
const Subscription = require('../subscription/models/subscription.Models');
const Organization = require('../organisation/models/organization.model');
const Company = require('../company/models/company.model');
const Unit = require('../unit/models/unit.model');
const { getMe } = require('./auth.service');

test('getMe returns populated hierarchy objects for refresh hydration', async () => {
  const original = {
    userFindOne: User.findOne,
    employeeFindOne: Employee.findOne,
    subscriptionFindOne: Subscription.findOne,
    organizationFindById: Organization.findById,
    companyFindById: Company.findById,
    unitFindById: Unit.findById,
  };

  const organization = { _id: 'org-id', name: 'Organization' };
  const company = { _id: 'company-id', company_name: 'Company' };
  const unit = { _id: 'unit-id', name: 'Unit Name' };

  try {
    const currentUser = {
      _id: 'user-id',
      org_id: 'org-id',
      company_id: 'company-id',
      unit_id: 'unit-id',
      roleId: {
        _id: 'role-id',
        name: 'Unit Admin',
        slug: 'unit_admin',
        level: 'unit',
        permissions: [],
      },
    };

    User.findOne = () => ({
      populate() { return this; },
      select: async () => currentUser,
    });
    Subscription.findOne = () => ({ lean: async () => null });
    Employee.findOne = () => ({
      select() { return this; },
      lean: async () => null,
    });
    Organization.findById = () => ({
      select() { return this; },
      lean: async () => organization,
    });
    Company.findById = () => ({
      select() { return this; },
      lean: async () => company,
    });
    Unit.findById = () => ({
      select() { return this; },
      lean: async () => unit,
    });

    const result = await getMe({ userId: 'user-id' });

    assert.equal(result.user.unit_id, 'unit-id');
    assert.deepEqual(result.user.organization, organization);
    assert.deepEqual(result.user.company, company);
    assert.deepEqual(result.user.unit, unit);
  } finally {
    User.findOne = original.userFindOne;
    Employee.findOne = original.employeeFindOne;
    Subscription.findOne = original.subscriptionFindOne;
    Organization.findById = original.organizationFindById;
    Company.findById = original.companyFindById;
    Unit.findById = original.unitFindById;
  }
});