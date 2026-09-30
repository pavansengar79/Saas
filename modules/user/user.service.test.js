const assert = require('node:assert/strict');
const { test } = require('node:test');

const User = require('../auth/models/user.model');
const Employee = require('../employee/models/employee.model');
const Role = require('../role/role.model');
const UserProgression = require('./models/userProgression.model');
const { getUsers, updateUser } = require('./user.service');

test('getUsers resolves unlinked unit Employee photos without crossing units', async () => {
  const original = {
    userFind: User.find,
    userCountDocuments: User.countDocuments,
    employeeFind: Employee.find,
    roleFindOne: Role.findOne,
    roleFind: Role.find,
  };

  const makeUser = (id, unitId, profilePhoto = null) => ({
    _id: id,
    email: 'admin@example.com',
    unit_id: { _id: unitId, name: unitId },
    toObject() {
      return {
        _id: this._id,
        email: this.email,
        unit_id: this.unit_id,
        roleId: { level: 'unit' },
        profilePhoto,
      };
    },
  });

  try {
    const users = [
      makeUser('user-one', 'unit-one'),
      makeUser('user-two', 'unit-two', 'user-photo'),
      makeUser('user-three', 'unit-three', 'old-photo'),
    ];
    const employees = [
      {
        userId: null,
        email: 'admin@example.com',
        unit_id: 'unit-one',
        profilePhoto: 'employee-photo',
        departmentId: null,
      },
      {
        userId: 'user-three',
        email: 'admin@example.com',
        unit_id: 'unit-three',
        profilePhoto: 'linked-photo',
        departmentId: null,
      },
    ];

    Role.findOne = () => ({ select: () => ({ lean: async () => null }) });
    Role.find = () => ({ distinct: async () => ['unit-role'] });
    User.find = () => ({
      select() { return this; },
      populate() { return this; },
      sort() { return this; },
      skip() { return this; },
      limit: async () => users,
    });
    User.countDocuments = async () => users.length;
    Employee.find = (filter) => {
      assert.equal(filter.company_id, 'company-one');
      assert.equal(filter.isDeleted, false);
      assert.deepEqual(filter.$or[1], {
        userId: null,
        email: { $in: users.map((user) => user.email) },
      });
      return {
        select() { return this; },
        populate: async () => employees,
      };
    };

    const result = await getUsers({}, { level: 'company', orgId: 'org-one', companyId: 'company-one' });

    assert.equal(result.users[0].profilePhoto, 'employee-photo');
    assert.equal(result.users[1].profilePhoto, 'user-photo');
    assert.equal(result.users[2].profilePhoto, 'linked-photo');
  } finally {
    User.find = original.userFind;
    User.countDocuments = original.userCountDocuments;
    Employee.find = original.employeeFind;
    Role.findOne = original.roleFindOne;
    Role.find = original.roleFind;
  }
});

test('updateUser rejects a parent-to-child role downgrade', async () => {
  const original = {
    userFindOne: User.findOne,
    roleFindOne: Role.findOne,
    roleFindById: Role.findById,
  };

  try {
    const targetUser = {
      _id: 'target-user',
      roleId: 'company-role',
    };
    User.findOne = async () => targetUser;
    Role.findOne = () => ({
      select: () => ({
        lean: async () => ({ slug: 'employee', level: 'unit' }),
      }),
    });
    Role.findById = () => ({
      select: () => ({
        lean: async () => ({ level: 'company' }),
      }),
    });

    await assert.rejects(
      updateUser('target-user', { roleId: 'unit-role' }, {
        level: 'org',
        userId: 'org-admin',
        orgId: 'org-one',
      }),
      /cannot downgrade the user's level/
    );
  } finally {
    User.findOne = original.userFindOne;
    Role.findOne = original.roleFindOne;
    Role.findById = original.roleFindById;
  }
});

test('updateUser allows company admin to promote a unit user and clears unit scope', async () => {
  const original = {
    userFindOne: User.findOne,
    userFindById: User.findById,
    roleFindOne: Role.findOne,
    roleFindById: Role.findById,
    employeeFindOne: Employee.findOne,
    progressionCreate: UserProgression.create,
  };

  try {
    const targetUser = {
      _id: 'target-user',
      roleId: 'unit-role',
      company_id: 'company-one',
      unit_id: 'unit-one',
      save: async () => {},
    };
    User.findOne = async (filter) => {
      assert.equal(filter.company_id, 'company-one');
      assert.equal(Object.hasOwn(filter, 'unit_id'), false);
      return targetUser;
    };
    Role.findOne = () => ({
      select: () => ({
        lean: async () => ({ slug: 'company_hr_manager', level: 'company' }),
      }),
    });
    Role.findById = () => ({
      select: () => ({
        lean: async () => ({ level: 'unit' }),
      }),
    });
    UserProgression.create = async () => {};
    Employee.findOne = () => ({
      select: () => ({ lean: async () => null }),
    });
    User.findById = () => ({
      populate() { return this; },
      lean: async () => ({ roleId: 'company-role', unit_id: null }),
    });

    const result = await updateUser('target-user', { roleId: 'company-role' }, {
      level: 'company',
      userId: 'company-admin',
      orgId: 'org-one',
      companyId: 'company-one',
    });

    assert.equal(targetUser.roleId, 'company-role');
    assert.equal(targetUser.unit_id, null);
    assert.equal(result.unit_id, null);
  } finally {
    User.findOne = original.userFindOne;
    User.findById = original.userFindById;
    Role.findOne = original.roleFindOne;
    Role.findById = original.roleFindById;
    Employee.findOne = original.employeeFindOne;
    UserProgression.create = original.progressionCreate;
  }
});