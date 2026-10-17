const assert = require('node:assert/strict');
const { test } = require('node:test');

const Attendance = require('./models/attendance.model');
const Employee = require('../employee/models/employee.model');
const Holiday = require('../holiday/models/holiday.models');
const LeaveRequest = require('../leave/models/leaveRequest.models');
const CompanyConfig = require('../companyConfig/models/companyConfig.model');
const attendanceValidation = require('./attendance.validation');
const { getMyAttendance, getMySummary, getTeamAttendance, getAllAttendance } = require('./attendance.service');

test('self attendance detail and summary use the same tenant and month filter', async () => {
  const original = {
    attendanceFind: Attendance.find,
    attendanceAggregate: Attendance.aggregate,
    employeeFindOne: Employee.findOne,
    configFindOne: CompanyConfig.findOne,
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
    CompanyConfig.findOne = () => ({ select() { return this; }, lean: async () => ({ timezone: 'Asia/Kolkata' }) });
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

    assert.deepEqual({ ...detailFilter, unit_id: employee.unit_id }, summaryFilter);
    assert.equal(detailFilter.org_id, employee.org_id);
    assert.equal(detailFilter.company_id, employee.company_id);
    assert.equal(detailFilter.employeeId, employee._id);
    assert.equal(detailFilter.isDeleted, false);
    assert.deepEqual(detailFilter.date, {
      $gte: new Date('2026-09-30T18:30:00.000Z'),
      $lt: new Date('2026-10-31T18:30:00.000Z'),
    });
  } finally {
    Attendance.find = original.attendanceFind;
    Attendance.aggregate = original.attendanceAggregate;
    Employee.findOne = original.employeeFindOne;
    CompanyConfig.findOne = original.configFindOne;
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

test('team summary counts missing weekdays independently of paginated rows', async () => {
  const original = {
    attendanceFind: Attendance.find,
    attendanceCount: Attendance.countDocuments,
    employeeFind: Employee.find,
    employeeFindOne: Employee.findOne,
    holidayFind: Holiday.find,
    leaveFind: LeaveRequest.find,
    configFindOne: CompanyConfig.findOne,
  };
  const manager = { _id: 'manager-id' };
  const teammate = { _id: 'teammate-id' };
  const attendanceRecord = { employeeId: manager._id, date: new Date('2020-01-06T06:00:00Z'), status: 'PRESENT' };
  const halfDayRecord = { employeeId: manager._id, date: new Date('2020-01-07T06:00:00Z'), status: 'HALF_DAY' };
  const attendanceRecords = [attendanceRecord, halfDayRecord];

  try {
    CompanyConfig.findOne = () => ({ select() { return this; }, lean: async () => ({ timezone: 'Asia/Kolkata' }) });
    Employee.findOne = () => ({ select: async () => manager });
    Employee.find = () => ({ select() { return this; }, lean: async () => [manager, teammate], then(resolve) { return Promise.resolve([manager, teammate]).then(resolve); } });
    Attendance.find = () => ({
      offset: 0,
      pageSize: attendanceRecords.length,
      populate() { return this; },
      sort() { return this; },
      skip(offset) { this.offset = offset; return this; },
      limit(pageSize) { this.pageSize = pageSize; return this; },
      select() { return this; },
      lean() { return Promise.resolve(attendanceRecords.slice(this.offset, this.offset + this.pageSize)); },
      then(resolve) { return Promise.resolve(attendanceRecords).then(resolve); },
    });
    Attendance.countDocuments = async () => attendanceRecords.length;
    Holiday.find = () => ({ select() { return this; }, lean: async () => [], then(resolve) { return Promise.resolve([]).then(resolve); } });
    LeaveRequest.find = () => ({ populate() { return this; }, select() { return this; }, lean: async () => [], then(resolve) { return Promise.resolve([]).then(resolve); } });

    const query = { startDate: '2020-01-06', endDate: '2020-01-07', page: 1, limit: 1 };
    const user = { userId: 'user-id', orgId: 'org-id', companyId: 'company-id' };
    const teamResult = await getTeamAttendance(query, user);
    const hrResult = await getAllAttendance(query, user);

    assert.equal(teamResult.records.length, 1);
    assert.equal(teamResult.summary.present, 2);
    assert.equal(teamResult.summary.absent, 2);
    assert.equal(teamResult.summary.late, 0);
    assert.deepEqual(teamResult.overview, { present: 2, absent: 2, late: 0, wfh: 0, halfDay: 1, onLeave: 0, attendedWorkdays: 2, availableWorkdays: 4 });
    assert.equal(hrResult.records.length, 1);
    assert.deepEqual(hrResult.overview, { present: 2, late: 0, onLeave: 0, absent: 2, attendedWorkdays: 2, availableWorkdays: 4 });

    const nextPage = await getTeamAttendance({ ...query, page: 2 }, user);
    assert.deepEqual(nextPage.overview, teamResult.overview);
    assert.equal(nextPage.records.length, 1);
    const hrNextPage = await getAllAttendance({ ...query, page: 2 }, user);
    assert.deepEqual(hrNextPage.overview, hrResult.overview);
    assert.equal(hrNextPage.records.length, 1);

    attendanceRecords.push({ employeeId: manager._id, date: new Date('2020-01-11T06:00:00Z'), status: 'PRESENT' });
    const weekendQuery = { ...query, endDate: '2020-01-11' };
    const teamWeekend = await getTeamAttendance(weekendQuery, user);
    const hrWeekend = await getAllAttendance(weekendQuery, user);
    assert.equal(teamWeekend.overview.present, 3);
    assert.equal(teamWeekend.overview.attendedWorkdays, 2);
    assert.equal(teamWeekend.overview.availableWorkdays, 10);
    assert.equal(hrWeekend.overview.present, 3);
    assert.equal(hrWeekend.overview.attendedWorkdays, 2);
    assert.equal(hrWeekend.overview.availableWorkdays, 10);
    attendanceRecords.pop();

    Employee.find = () => ({ select() { return this; }, lean: async () => [manager, {
      ...teammate, joiningDate: new Date('2020-01-07T00:00:00Z'),
    }], then(resolve) { return Promise.resolve([manager, teammate]).then(resolve); } });
    const afterJoining = await getTeamAttendance(query, user);
    assert.equal(afterJoining.summary.absent, 1);
    Employee.find = () => ({ select() { return this; }, lean: async () => [manager, teammate], then(resolve) { return Promise.resolve([manager, teammate]).then(resolve); } });

    Employee.find = (filter) => {
      const members = filter.departmentId || filter._id ? [teammate] : [manager, teammate];
      return { select() { return this; }, lean: async () => members, then(resolve) { return Promise.resolve(members).then(resolve); } };
    };
    const departmentResult = await getAllAttendance({ ...query, departmentId: 'department-id' }, user);
    assert.equal(departmentResult.overview.attendedWorkdays, 0);
    assert.equal(departmentResult.overview.availableWorkdays, 2);
    Employee.find = () => ({ select() { return this; }, lean: async () => [manager, teammate], then(resolve) { return Promise.resolve([manager, teammate]).then(resolve); } });

    const holidays = [{ date: new Date('2020-01-07T06:00:00Z') }];
    const leaves = [{
      employeeId: teammate._id,
      startDate: new Date('2020-01-06T06:00:00Z'),
      endDate: new Date('2020-01-06T18:00:00Z'),
    }];
    Holiday.find = () => ({ select() { return this; }, lean: async () => holidays, then(resolve) { return Promise.resolve(holidays).then(resolve); } });
    LeaveRequest.find = () => ({ populate() { return this; }, select() { return this; }, lean: async () => leaves, then(resolve) { return Promise.resolve(leaves).then(resolve); } });
    const withTimeOff = await getTeamAttendance(query, user);
    assert.equal(withTimeOff.summary.absent, 0);
    assert.equal(withTimeOff.summary.onLeave, 1);
    assert.equal(withTimeOff.overview.attendedWorkdays, 1);
    assert.equal(withTimeOff.overview.availableWorkdays, 1);
    const hrWithTimeOff = await getAllAttendance(query, user);
    assert.equal(hrWithTimeOff.overview.attendedWorkdays, 1);
    assert.equal(hrWithTimeOff.overview.availableWorkdays, 1);
  } finally {
    Attendance.find = original.attendanceFind;
    Attendance.countDocuments = original.attendanceCount;
    Employee.find = original.employeeFind;
    Employee.findOne = original.employeeFindOne;
    Holiday.find = original.holidayFind;
    LeaveRequest.find = original.leaveFind;
    CompanyConfig.findOne = original.configFindOne;
  }
});