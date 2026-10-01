const assert = require('node:assert/strict');
const { test } = require('node:test');

const Attendance = require('./models/attendance.model');
const Employee = require('../employee/models/employee.model');
const attendanceValidation = require('./attendance.validation');
const { getMyAttendance, getMySummary } = require('./attendance.service');

test('self attendance detail and summary use the same tenant and month filter', async () => {
  const original = {
    attendanceFind: Attendance.find,
    attendanceAggregate: Attendance.aggregate,
    employeeFindOne: Employee.findOne,
  };

  const employee = {
    _id: 'employee-id',
    org_id: 'org-id',
    company_id: 'company-id',
    unit_id: 'unit-id',
  };
  const user = {
    userId: 'user-id',
    orgId: 'org-id',
    companyId: 'company-id',
    unitId: 'unit-id',
  };
  let detailFilter;
  let summaryFilter;

  try {
    Employee.findOne = async (filter) => {
      assert.deepEqual(filter, {
        userId: 'user-id',
        org_id: 'org-id',
        company_id: 'company-id',
        unit_id: 'unit-id',
        isDeleted: false,
      });
      return employee;
    };
    Attendance.find = (filter) => {
      detailFilter = filter;
      return {
        sort() { return this; },
        select: async () => [],
      };
    };
    Attendance.aggregate = async (pipeline) => {
      summaryFilter = pipeline[0].$match;
      return [];
    };

    await getMyAttendance({ month: '2026-10' }, user);
    await getMySummary({ month: '2026-10' }, user);

    assert.deepEqual(detailFilter, summaryFilter);
    assert.equal(detailFilter.org_id, employee.org_id);
    assert.equal(detailFilter.company_id, employee.company_id);
    assert.equal(detailFilter.unit_id, employee.unit_id);
    assert.equal(detailFilter.employeeId, employee._id);
    assert.equal(detailFilter.isDeleted, false);
    assert.deepEqual(detailFilter.date, {
      $gte: new Date('2026-10-01T00:00:00.000Z'),
      $lt: new Date('2026-11-01T00:00:00.000Z'),
    });
  } finally {
    Attendance.find = original.attendanceFind;
    Attendance.aggregate = original.attendanceAggregate;
    Employee.findOne = original.employeeFindOne;
  }
});

test('self attendance validators accept optional scope IDs used by existing clients', () => {
  const query = {
    month: '2026-10',
    orgId: '6aaa43e39580f2755066f57c',
    companyId: '6aaa43e49580f2755066f57e',
    unit_id: '6aaa43e49580f2755066f580',
  };

  for (const schema of [attendanceValidation.getMyAttendance, attendanceValidation.getSummary]) {
    const { error } = schema.validate(query, { allowUnknown: false });
    assert.equal(error, undefined);
  }
});