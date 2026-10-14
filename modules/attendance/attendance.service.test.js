const assert = require('node:assert/strict');
const { test } = require('node:test');

const Attendance = require('./models/attendance.model');
const Employee = require('../employee/models/employee.model');
const Holiday = require('../holiday/models/holiday.models');
const LeaveRequest = require('../leave/models/leaveRequest.models');
const attendanceValidation = require('./attendance.validation');
const { getMyAttendance, getMySummary, getTeamAttendance, getAllAttendance } = require('./attendance.service');

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

test('team and HR overviews count missing weekdays independently of paginated rows', async () => {
  const original = {
    attendanceFind: Attendance.find,
    attendanceCount: Attendance.countDocuments,
    employeeFind: Employee.find,
    employeeFindOne: Employee.findOne,
    holidayFind: Holiday.find,
    leaveFind: LeaveRequest.find,
  };
  const manager = { _id: 'manager-id' };
  const teammate = { _id: 'teammate-id' };
  const attendanceRecord = { employeeId: manager._id, date: new Date('2020-01-06T06:00:00Z'), status: 'PRESENT' };

  try {
    Employee.findOne = () => ({ select: async () => manager });
    Employee.find = () => ({ select: async () => [manager, teammate] });
    Attendance.find = () => ({
      populate() { return this; },
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      select: async () => [attendanceRecord],
    });
    Attendance.countDocuments = async () => 1;
    Holiday.find = () => ({ select: async () => [] });
    LeaveRequest.find = () => ({ select: async () => [] });

    const query = { startDate: '2020-01-06', endDate: '2020-01-07', page: 1, limit: 1 };
    const user = { userId: 'user-id', orgId: 'org-id', companyId: 'company-id' };
    const teamResult = await getTeamAttendance(query, user);
    const hrResult = await getAllAttendance(query, user);

    for (const result of [teamResult, hrResult]) {
      assert.equal(result.records.length, 1);
      assert.equal(result.overview.present, 1);
      assert.equal(result.overview.absent, 3);
      assert.equal(result.overview.late, 0);
    }

    Employee.find = () => ({ select: async () => [manager, {
      ...teammate, joiningDate: new Date('2020-01-07T00:00:00Z'),
    }] });
    const afterJoining = await getTeamAttendance(query, user);
    assert.equal(afterJoining.overview.absent, 2);
    Employee.find = () => ({ select: async () => [manager, teammate] });

    Holiday.find = () => ({ select: async () => [{ date: new Date('2020-01-07T06:00:00Z') }] });
    LeaveRequest.find = () => ({ select: async () => [{
      employeeId: teammate._id,
      startDate: new Date('2020-01-06T06:00:00Z'),
      endDate: new Date('2020-01-06T18:00:00Z'),
    }] });
    const withTimeOff = await getTeamAttendance(query, user);
    assert.equal(withTimeOff.overview.absent, 0);
    assert.equal(withTimeOff.overview.onLeave, 1);
  } finally {
    Attendance.find = original.attendanceFind;
    Attendance.countDocuments = original.attendanceCount;
    Employee.find = original.employeeFind;
    Employee.findOne = original.employeeFindOne;
    Holiday.find = original.holidayFind;
    LeaveRequest.find = original.leaveFind;
  }
});