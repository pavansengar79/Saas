const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');

const LeavePolicy = require('./models/leavePolicy.model');
const LeaveType = require('../leave/models/leaveType.models');
const LeaveRequest = require('../leave/models/leaveRequest.models');
const Employee = require('../employee/models/employee.model');
const policyVersionService = require('../policyVersion/policyVersion.service');
const { updatePolicySchema } = require('./leavePolicy.validation');
const { updatePolicy } = require('./leavePolicy.service');
const { calculateDynamicLeaveBalances } = require('../leave/leave.service');

test('updating paid leave allocation recalculates balances and summary', async () => {
  const original = {
    policyFindOne: LeavePolicy.findOne,
    employeeFindById: Employee.findById,
    leaveTypeFindById: LeaveType.findById,
    leaveRequestFind: LeaveRequest.find,
    saveVersionSnapshot: policyVersionService.saveVersionSnapshot,
  };
  const orgId = new mongoose.Types.ObjectId();
  const companyId = new mongoose.Types.ObjectId();
  const unitId = new mongoose.Types.ObjectId();
  const employeeId = new mongoose.Types.ObjectId();
  const paidTypeId = new mongoose.Types.ObjectId();
  const policy = new LeavePolicy({
    org_id: orgId,
    company_id: companyId,
    unit_id: unitId,
    name: 'Standard Leave Policy',
    status: 'active',
    effectiveFrom: new Date('2025-01-01'),
    version: 6,
    leaveTypes: [
      { name: 'Casual Leave', code: 'CL', credit: { totalPerYear: 6 } },
      { name: 'Sick Leave', code: 'SL', credit: { totalPerYear: 6 } },
      { leaveTypeId: paidTypeId, name: 'Paid Leave', code: 'PL', credit: { totalPerYear: 12 } },
    ],
  });
  const user = { userId: new mongoose.Types.ObjectId(), orgId, companyId, unitId };
  let saved = false;

  try {
    LeavePolicy.findOne = async () => policy;
    policyVersionService.saveVersionSnapshot = async () => {};
    policy.save = async () => { await policy.validate(); saved = true; return policy; };
    Employee.findById = () => ({
      select() { return this; },
      populate: async () => ({
        _id: employeeId, name: 'Employee', employeeId: 'E-1',
        org_id: orgId, company_id: companyId, unit_id: { _id: unitId, name: 'Unit' },
      }),
    });
    LeaveType.findById = () => ({ select: async () => null });
    LeaveRequest.find = filter => ({
      select() { return this; },
      lean: async () => filter.leaveTypeId.equals(paidTypeId) ? [{
        startDate: new Date('2026-10-01'),
        endDate: new Date('2026-10-06'),
        totalDays: 4,
        status: 'PENDING',
      }] : [],
    });

    const { error, value } = updatePolicySchema.validate({
      leaveTypes: policy.leaveTypes.toObject().map(leaveType => ({
        name: leaveType.name,
        code: leaveType.code,
        leaveTypeId: leaveType.leaveTypeId?.toString() || null,
        credit: { totalPerYear: leaveType.name === 'Paid Leave' ? 10 : 6 },
      })),
    });
    assert.ifError(error);
    await updatePolicy(policy._id, value, user);
    assert.equal(saved, true);
    assert.equal(policy.version, 7);

    const result = await calculateDynamicLeaveBalances(employeeId, 2026);
    assert.equal(result.policy.version, 7);
    assert.equal(result.balances.find(balance => balance.leaveTypeId.name === 'Paid Leave').allocated, 10);
    assert.deepEqual(result.summary, {
      totalLeaveTypes: 3,
      totalAllocated: 22,
      totalUsed: 0,
      totalPending: 4,
      totalRemaining: 18,
    });
  } finally {
    LeavePolicy.findOne = original.policyFindOne;
    Employee.findById = original.employeeFindById;
    LeaveType.findById = original.leaveTypeFindById;
    LeaveRequest.find = original.leaveRequestFind;
    policyVersionService.saveVersionSnapshot = original.saveVersionSnapshot;
  }
});