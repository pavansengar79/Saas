// utils/leaveUtils.js
// UPDATED — tenantId → org_id + company_id + unit_id

const LeaveRequest = require("../modules/leave/models/leaveRequest.models");
const LeaveBalance = require("../modules/leave/models/leaveBalance.models");

// ─── Working Days Calculator ──────────────────────────────────────────────────
const calculateWorkingDays = (
  startDate,
  endDate,
  workingDays = ["MON", "TUE", "WED", "THU", "FRI"],
  isHalfDay = false
) => {
  if (isHalfDay) return 0.5;

  const DAY_MAP = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const workingDayNumbers = new Set(workingDays.map((d) => DAY_MAP[d]));

  let count = 0;
  const current = new Date(startDate);
  current.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  while (current <= end) {
    if (workingDayNumbers.has(current.getDay())) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
};

// ─── Overlap Detector ─────────────────────────────────────────────────────────
const checkLeaveOverlap = async (
  employeeId,
  startDate,
  endDate,
  excludeRequestId = null
) => {
  const query = {
    employeeId,
    status:    { $in: ["PENDING", "UNDER_REVIEW", "APPROVED"] },
    startDate: { $lte: endDate },
    endDate:   { $gte: startDate },
  };

  if (excludeRequestId) query._id = { $ne: excludeRequestId };

  const conflicting = await LeaveRequest.findOne(query)
    .select("startDate endDate status leaveTypeId")
    .populate("leaveTypeId", "name code");

  return { hasOverlap: !!conflicting, conflictingRequest: conflicting };
};

// ─── Balance Checker ──────────────────────────────────────────────────────────
const getOrCreateLeaveBalance = async (
  org_id,
  company_id,
  unit_id,
  employeeId,
  leaveTypeId,
  year = new Date().getFullYear()
) => {
  let balance = await LeaveBalance.findOne({
    org_id,
    company_id,
    employeeId,
    leaveTypeId,
    year,
  });

  if (!balance) {
    const LeaveType = require("../modules/leave/models/leaveType.models");
    const leaveType = await LeaveType.findById(leaveTypeId).select("defaultDaysPerYear");

    balance = await LeaveBalance.create({
      org_id,
      company_id,
      unit_id:        unit_id || null,
      employeeId,
      leaveTypeId,
      year,
      totalAllocated: leaveType ? leaveType.defaultDaysPerYear : 0,
      used:           0,
      pending:        0,
      remaining:      leaveType ? leaveType.defaultDaysPerYear : 0,
      adjustmentHistory: [{
        days:       leaveType ? leaveType.defaultDaysPerYear : 0,
        reason:     "Auto-initialized on first request",
        adjustedBy: employeeId,
        type:       "YEAR_INITIALIZATION",
      }],
    });
  }

  return balance;
};

// ─── Sufficient Balance Check ─────────────────────────────────────────────────
const checkSufficientBalance = (balance, requestedDays, isPaidLeave = true) => {
  if (!isPaidLeave) {
    return { sufficient: true, available: Infinity, message: "Unpaid leave" };
  }

  const available = balance.remaining;

  if (available < requestedDays) {
    return {
      sufficient: false,
      available,
      message: `Insufficient balance. Available: ${available} day(s), Requested: ${requestedDays} day(s)`,
    };
  }

  return { sufficient: true, available, message: "Balance sufficient" };
};

// ─── Notice Period Checker ────────────────────────────────────────────────────
const checkNoticeRequirement = (startDate, minNoticeDays = 0) => {
  if (minNoticeDays === 0) return { valid: true, message: "No notice required" };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const leaveStart = new Date(startDate);
  leaveStart.setHours(0, 0, 0, 0);

  const noticeDays = Math.floor((leaveStart - today) / (1000 * 60 * 60 * 24));

  if (noticeDays < minNoticeDays) {
    return {
      valid:   false,
      message: `Minimum ${minNoticeDays} day(s) advance notice required. You have ${noticeDays} day(s).`,
    };
  }

  return { valid: true, message: "Notice requirement met" };
};

// ─── Consecutive Days Checker ─────────────────────────────────────────────────
const checkConsecutiveDaysLimit = (totalDays, maxConsecutiveDays = null) => {
  if (!maxConsecutiveDays) return { valid: true, message: "No consecutive days limit" };

  if (totalDays > maxConsecutiveDays) {
    return {
      valid:   false,
      message: `Maximum ${maxConsecutiveDays} consecutive days allowed. Requested: ${totalDays}`,
    };
  }

  return { valid: true, message: "Within consecutive days limit" };
};

// ─── L1 Approver Resolver ─────────────────────────────────────────────────────
const resolveL1Approver = async (employee) => {
  if (!employee.reportingManagerId) return null;

  const Employee = require("../modules/employee/models/employee.model");
  const manager  = await Employee.findOne({
    _id:       employee.reportingManagerId,
    isDeleted: false,
    status:    "ACTIVE",
  }).select("userId");

  if (!manager || !manager.userId) return null;
  return manager.userId;
};

// ─── L2 Approver Resolver ─────────────────────────────────────────────────────
// UPDATED — tenantId → company_id + unit_id
const resolveL2Approver = async (company_id, unit_id) => {
  const User = require("../modules/auth/models/user.model");
  const Role = require("../modules/role/role.model");

  // Find the hr_manager system role.
  const hrRole = await Role.findOne({
    slug:     "hr_manager",
    isSystem: true,
  }).select("_id");

  if (!hrRole) return null;

  // Search at the unit level first; fall back to the company level if not found.
  const filter = {
    roleId:    hrRole._id,
    company_id,
    status:    "ACTIVE",
    isDeleted: false,
  };

  if (unit_id) filter.unit_id = unit_id;

  let hrUser = await User.findOne(filter).select("_id");

  // Fallback — company level
  if (!hrUser && unit_id) {
    hrUser = await User.findOne({
      roleId:    hrRole._id,
      company_id,
      status:    "ACTIVE",
      isDeleted: false,
    }).select("_id");
  }

  return hrUser ? hrUser._id : null;
};

// ─── Date Formatting ──────────────────────────────────────────────────────────
const formatLeaveDate = (date) => {
  return new Date(date).toLocaleDateString("en-IN", {
    day:   "2-digit",
    month: "short",
    year:  "numeric",
  });
};

module.exports = {
  calculateWorkingDays,
  checkLeaveOverlap,
  getOrCreateLeaveBalance,
  checkSufficientBalance,
  checkNoticeRequirement,
  checkConsecutiveDaysLimit,
  resolveL1Approver,
  resolveL2Approver,
  formatLeaveDate,
};