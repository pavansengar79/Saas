// modules/attendance/attendanceRegularization.service.js
"use strict";

const AttendanceRegularization = require("./models/attendanceRegularization.model");
const Attendance               = require("./models/attendance.model");
const Employee                 = require("../employee/models/employee.model");
const User                     = require("../auth/models/user.model");
const AppError                 = require("../../utils/appError");
const mongoose                 = require("mongoose");
const Notification  = require("../notification/notification.model");
const LeaveBalance = require("../leave/models/leaveBalance.models");
const LeaveRequest = require("../leave/models/leaveRequest.models");
const regularisationPolicyService = require("./regularisationPolicy.service");
const { resolveAttendancePolicy } = require("../../utils/policyResolver");
const CompanyConfig = require('../companyConfig/models/companyConfig.model');
const { correctAttendanceTimes } = require('./correctedAttendance');
const moment = require('moment-timezone');

const toObjId = (id) => new mongoose.Types.ObjectId(String(id));

// ─── Helper: find HR Manager of unit ─────────────────────────
const findHRManager = async (org_id, unit_id) => {
  const Role = require("../role/role.model");
  const hrRole = await Role.findOne({ slug: "hr_manager", isSystem: true }).lean();
  if (!hrRole) return null;
  return await User.findOne({
    org_id:  toObjId(org_id),
    unit_id: toObjId(unit_id),
    roleId:  hrRole._id,
    status:  "ACTIVE",
  }).select("_id").lean();
};


// ─── Resolve Approvers (Flexible — T-flexible) ────────────────
const resolveRegularizationApprovers = async (employee, user, approvalFlow) => {
  let l1ApproverId = null;
  let l2ApproverId = null;

  // L1 — Reporting Manager
  if (["L1_ONLY", "L1_L2"].includes(approvalFlow)) {
    if (employee.reportingManagerId) {
      const mgr = await Employee.findById(employee.reportingManagerId)
        .select("userId").lean();
      if (mgr?.userId) l1ApproverId = mgr.userId;
    }
  }

  // L2 — HR Manager
  if (["L2_ONLY", "L1_L2"].includes(approvalFlow)) {
    const hrUser = await findHRManager(user.orgId, user.unitId);
    if (hrUser?._id) l2ApproverId = hrUser._id;
  }

  // L1_ONLY but no reporting manager — fallback to L2
  if (approvalFlow === "L1_ONLY" && !l1ApproverId) {
    const hrUser = await findHRManager(user.orgId, user.unitId);
    if (hrUser?._id) l2ApproverId = hrUser._id;
  }

  return { l1ApproverId, l2ApproverId, approvalFlow };
};
// ─── Helper: recalculate attendance after approval ────────────
const recalculateAttendance = async (request, approvedBy) => {
  const config = await CompanyConfig.findOne({ org_id: request.org_id, company_id: request.company_id })
    .select('timezone overtimeEnabled overtimeThresholdHours').lean();
  const timezone = config?.timezone || 'Asia/Kolkata';
  // Request dates are calendar dates stored at UTC midnight, whereas attendance
  // dates are midnight in the organisation's timezone.
  const date = moment.tz(moment.utc(request.date).format('YYYY-MM-DD'), 'YYYY-MM-DD', timezone).toDate();

  let attendance = await Attendance.findOne({
    employeeId: request.employeeId,
    org_id:     request.org_id,
    date,
  });

  const before = attendance
    ? { status: attendance.status, checkIn: attendance.checkIn, checkOut: attendance.checkOut }
    : { status: null, checkIn: null, checkOut: null };
  const checkIn  = request.requestedCheckIn  || (attendance?.checkIn  || null);
  const checkOut = request.requestedCheckOut || (attendance?.checkOut || null);

  if (!attendance) {
    // Create new attendance record
    attendance = new Attendance({
      org_id:     request.org_id,
      company_id: request.company_id,
      unit_id:    request.unit_id,
      employeeId: request.employeeId,
      userId:     request.userId,
      date,
      checkIn,
      checkOut,
      status:        request.requestedStatus || "PRESENT",
      isRegularized: true,
      regularizedBy: toObjId(approvedBy),
      regularizedAt: new Date(),
      remarks:       `Regularized — Request ID: ${request._id}`,
    });
  } else {
    // Update existing
    if (request.requestedStatus)   attendance.status   = request.requestedStatus;
    attendance.isRegularized = true;
    attendance.regularizedBy = toObjId(approvedBy);
    attendance.regularizedAt = new Date();
    attendance.remarks       = `Regularized — Request ID: ${request._id}`;
  }

  const attendancePolicy = await resolveAttendancePolicy(
    request.employeeId.toString(), request.company_id.toString(), request.unit_id?.toString() || null
  );
  correctAttendanceTimes(attendance, request.requestedCheckIn, request.requestedCheckOut,
    timezone, config, attendancePolicy);
  if (attendance.workingHours !== null && !['ON_LEAVE', 'ABSENT', 'HOLIDAY', 'WEEKEND'].includes(request.requestedStatus)) {
    if (attendance.workingHours >= (attendance.standardHours || 8)) {
      attendance.status = attendance.isWFH ? 'WFH' : 'PRESENT';
    } else if (attendance.workingHours >= (attendance.halfDayThreshold || 4)) {
      attendance.status = 'HALF_DAY';
    }
  }
  // ─── LWP / Leave handling ────────────────────────────────────
  if (request.requestedStatus === "ON_LEAVE" && request.leaveTypeId) {

    // Balance check
    const balance = await LeaveBalance.findOne({
      employeeId:  request.employeeId,
      leaveTypeId: request.leaveTypeId,
      org_id:      request.org_id,
    });

    const hasBalance = balance && balance.remaining >= 1;

    if (hasBalance) {
      // Balance available — deduct it and automatically create a leave request
      balance.used      += 1;
      balance.remaining -= 1;
      await balance.save();

      await LeaveRequest.create({
        org_id:      request.org_id,
        company_id:  request.company_id,
        unit_id:     request.unit_id,
        employeeId:  request.employeeId,
        userId:      request.userId,
        leaveTypeId: request.leaveTypeId,
        startDate:   date,
        endDate:     date,
        totalDays:   1,
        reason:      `Auto-created via attendance regularisation — Request ID: ${request._id}`,
        status:      "APPROVED",
        isAutoCreated: true,
      });

      // Keep isLWP false
      request.isLWP = false;

    } else {
      // No balance available — LWP
      request.isLWP = true;

      // Mark attendance as LWP
      attendance.isLWP  = true;  // The attendance model also needs this field
    }
  }

  // AT-09: audit entry so the attendance log shows the day was regularized
  attendance.regularizationLog = attendance.regularizationLog || [];
  attendance.regularizationLog.push({
    at: attendance.regularizedAt || new Date(),
    by: toObjId(approvedBy),
    source: "REQUEST",
    type: request.regularizationType || request.type || null,
    requestId: request._id,
    remarks: request.reason || null,
    before,
    after: { status: attendance.status, checkIn: attendance.checkIn, checkOut: attendance.checkOut },
  });

  await attendance.save();
  return attendance;
};

// ─── Helper: recalculate payroll if a draft payslip already exists ────────────
// (TC-070 — approving a regularisation can change attendance/LOP for a day that
// has already been pulled into a payroll draft. If a DRAFT payslip exists for
// the affected employee + month, re-run payroll so numbers stay accurate.
// PUBLISHED/PAID payslips are left untouched — those require an explicit
// re-run via the payroll module once the period is unlocked.)
const triggerPayrollRecalculation = async (request, approvedBy) => {
  try {
    const Payslip           = require("../payrollPolicy/models/payslip.model");
    const payrollRunService = require("../payrollPolicy/payrollRun.service");

    const date  = new Date(request.date);
    const year  = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;

    const existingPayslip = await Payslip.findOne({
      employee_id: request.employeeId,
      year,
      month,
      status: "DRAFT",
    }).lean();

    if (!existingPayslip) return; // no payroll run yet for this period — nothing to refresh

    const monthStr = `${year}-${String(month).padStart(2, "0")}`;

    await payrollRunService.runForEmployee(
      request.employeeId,
      request.company_id,
      request.unit_id,
      monthStr,
      { userId: approvedBy, orgId: request.org_id, unitId: request.unit_id }
    );
  } catch (err) {
    // Don't let a payroll recalculation failure block the regularisation approval —
    // log it so payroll/HR can re-run manually (e.g. if the period is locked).
    console.error("[triggerPayrollRecalculation] Failed to recalculate payroll:", err.message);
  }
};

// ─── APPLY (Employee) ─────────────────────────────────────────
exports.applyRegularization = async (payload, user) => {
  const {
    date,
    requestedCheckIn,
    requestedCheckOut,
    requestedStatus = "PRESENT",
    reason,
    regularizationType,
    attachments = [],
    targetEmployeeId,
  } = payload;

  // AT-14 — Only HR/Unit Admin can raise a request on someone else's behalf
  const isOnBehalf = !!targetEmployeeId;
  if (isOnBehalf) {
    const allowedRoles = ["hr_manager", "unit_admin", "company_admin", "org_admin"];
    if (!allowedRoles.includes(user.role)) {
      throw new AppError("Only HR or Admin can raise regularisation on behalf of an employee", 403);
    }
  }

  if (!date)               throw new AppError("date is required", 400);
  if (!reason)             throw new AppError("reason is required", 400);
  if (!regularizationType) throw new AppError("regularizationType is required", 400);
  if (requestedStatus === "ON_LEAVE" && !payload.leaveTypeId) {
    throw new AppError("leaveTypeId is required when requestedStatus is ON_LEAVE", 400);
  }

  const reqDate = new Date(date);
  reqDate.setUTCHours(0, 0, 0, 0);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // Employee fetch
  let employee;

  if (isOnBehalf) {
    employee = await Employee.findOne({
      _id:       toObjId(targetEmployeeId),
      org_id:    toObjId(user.orgId),
      ...(user.companyId ? { company_id: toObjId(user.companyId) } : {}),
      isDeleted: false,
    }).lean();
    if (!employee) throw new AppError("Target employee not found", 404);

    if (user.level === "unit" && String(employee.unit_id) !== String(user.unitId)) {
      throw new AppError("You can only raise regularisation for employees in your unit", 403);
    }
  } else {
    employee = await Employee.findOne({
      userId: toObjId(user.userId),
      org_id: toObjId(user.orgId),
    }).lean();

    if (!employee && user.email) {
      employee = await Employee.findOne({
        email:  user.email,
        org_id: toObjId(user.orgId),
      }).lean();
    }

    if (!employee) throw new AppError("Employee record not found — please ensure your employee profile is linked", 404);
  }

  const employeeUserId = employee.userId || (!isOnBehalf ? user.userId : null);
  if (!employeeUserId) throw new AppError("Employee user account is not linked", 400);
  const companyConfig = await CompanyConfig.findOne({ org_id: user.orgId, company_id: employee.company_id })
    .select('timezone').lean();
  const attendanceDate = moment.tz(moment.utc(reqDate).format('YYYY-MM-DD'), 'YYYY-MM-DD',
    companyConfig?.timezone || 'Asia/Kolkata').toDate();
  const scopedUser = {
    ...user,
    companyId: employee.company_id,
    unitId: employee.unit_id,
  };

  // ─── FETCH AND ENFORCE EFFECTIVE POLICY ─────────────────────────
  const policy = await regularisationPolicyService.getEffectivePolicy(employee, scopedUser);
  const policyType = regularisationPolicyService.getPolicyTypeForRegularization(policy, regularizationType);
  if (!policyType) {
    throw new AppError(`Correction type '${regularizationType}' is not allowed by the active policy`, 400);
  }

  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  const monthlyCount = await AttendanceRegularization.countDocuments({
    employeeId: employee._id,
    org_id: toObjId(user.orgId),
    createdAt: { $gte: monthStart, $lt: monthEnd },
    status: { $nin: ["REJECTED", "CANCELLED"] },
    isDeleted: false,
  });
  const validation = await regularisationPolicyService.validateRequestAgainstPolicy(
    policy,
    { type: policyType, date: reqDate, attachments },
    monthlyCount
  );
  if (!validation.valid) throw new AppError(validation.errors.join("; "), 400);

  const approvalFlow = policy.approvalFlow;
  const autoApproval = approvalFlow === "AUTO"
    ? { autoApprove: true, reason: "Policy uses automatic approval" }
    : regularisationPolicyService.checkAutoApproval(
        policy,
        { type: policyType },
        monthlyCount
      );

  // Duplicate check
  const existing = await AttendanceRegularization.findOne({
    employeeId: employee._id,
    org_id:     toObjId(user.orgId),
    date:       reqDate,
    status:     { $in: ["PENDING", "UNDER_REVIEW"] },
    isDeleted:  false,
  });
  if (existing) throw new AppError("A regularization request already exists for this date", 409);

  // Attendance record fetch
  const attendance = await Attendance.findOne({
    employeeId: employee._id,
    org_id:     toObjId(user.orgId),
    date:       attendanceDate,
  }).lean();

  // Approvers resolve
  const { l1ApproverId, l2ApproverId } = await resolveRegularizationApprovers(
    employee,
    scopedUser,
    approvalFlow
  );

  const request = await AttendanceRegularization.create({
    org_id:            toObjId(user.orgId),
    company_id:        toObjId(employee.company_id),
    unit_id:           toObjId(employee.unit_id),
    raisedOnBehalf:    isOnBehalf,
    raisedBy:          toObjId(user.userId),
    employeeId:        employee._id,
    userId:            toObjId(employeeUserId),
    attendanceId:      attendance?._id || null,
    date:              reqDate,
    approvalFlow,
    policyId:          policy?._id || null,  // Link to policy
    leaveTypeId:       payload.leaveTypeId ? toObjId(payload.leaveTypeId) : null,
    requestedCheckIn:  requestedCheckIn  ? new Date(requestedCheckIn)  : null,
    requestedCheckOut: requestedCheckOut ? new Date(requestedCheckOut) : null,
    requestedStatus,
    reason,
    regularizationType,
    attachments,
    l1ApproverId,
    l2ApproverId,
    status:    "PENDING",
    createdBy: toObjId(user.userId),
  });

  if (autoApproval.autoApprove) {
    request.approvalHistory.push({
      level: 0,
      actorId: toObjId(user.userId),
      actorName: user.name || "Policy Engine",
      actorRole: user.role,
      action: "APPROVED",
      comment: autoApproval.reason,
      actionAt: new Date(),
    });
    await recalculateAttendance(request, user.userId);
    await triggerPayrollRecalculation(request, user.userId);
    request.isApplied = true;
    request.appliedAt = new Date();
    request.appliedBy = toObjId(user.userId);
    request.status = "APPLIED";
    await request.save();
  }

  // N-05 — Notify the approver
  const notifyUserId = autoApproval.autoApprove ? null : l1ApproverId || l2ApproverId;
  if (notifyUserId) {
    Notification.create({
      org_id:  toObjId(user.orgId),
      userId:  notifyUserId,
      type:    "REGULARIZATION_APPLIED",
      title:   "New Regularisation Request",
      message: `${employee.name} submitted a regularisation request for ${date}.`,
      meta: {
        regularizationId: request._id,
        employeeId:       employee._id,
        date,
      },
    }).catch(() => {});
  }

  // HR acting on behalf of an employee — notify the employee too
  if (isOnBehalf) {
    Notification.create({
      org_id:  toObjId(user.orgId),
      userId:  request.userId,
      type:    "REGULARIZATION_APPLIED",
      title:   "Regularisation Request Raised on Your Behalf",
      message: `HR submitted a regularisation request on your behalf for ${date}.`,
      meta:    { regularizationId: request._id, date },
    }).catch(() => {});
  }

  return request;
};

// ─── GET MY REQUESTS (Employee) ──────────────────────────────
exports.getMyRequests = async (query, user) => {
  const { page = 1, limit = 10, status, month } = query;

  let employee = await Employee.findOne({
    userId: toObjId(user.userId),
    org_id: toObjId(user.orgId),
  }).lean();
  if (!employee && user.email) {
    employee = await Employee.findOne({ email: user.email, org_id: toObjId(user.orgId) }).lean();
  }
  if (!employee) throw new AppError("Employee record not found", 404);

  const filter = {
    employeeId: employee._id,
    org_id:     toObjId(user.orgId),
    isDeleted:  false,
  };

  if (status) filter.status = status;
  if (month) {
    const start = new Date(`${month}-01`);
    const end   = new Date(start);
    end.setMonth(end.getMonth() + 1);
    filter.date = { $gte: start, $lt: end };
  }

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await AttendanceRegularization.countDocuments(filter);
  const requests = await AttendanceRegularization.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .populate("l1ApproverId", "name email")
    .populate("l2ApproverId", "name email")
    .lean();

  return { requests, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) };
};

// ─── GET PENDING FOR APPROVAL (Manager/HR) ───────────────────
exports.getPendingApprovals = async (query, user) => {
  const { page = 1, limit = 10, status } = query;

  const filter = {
    org_id:    toObjId(user.orgId),
    isDeleted: false,
  };

  if (user.role === "manager") {
    // L1 — PENDING only
    filter.l1ApproverId = toObjId(user.userId);
    filter.status       = "PENDING";
  } else if (user.role === "hr_manager") {
    // L2 — both PENDING (L2_ONLY flow) and UNDER_REVIEW (L1_L2 flow)
    filter.l2ApproverId = toObjId(user.userId);
    filter.status       = { $in: ["PENDING", "UNDER_REVIEW"] };
  } else {
    // Unit Admin / higher — all requests from their unit
    filter.unit_id = toObjId(user.unitId);
    if (status) filter.status = status;
  }

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await AttendanceRegularization.countDocuments(filter);
  const requests = await AttendanceRegularization.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .populate("employeeId",    "name employeeId email")
    .populate("l1ApproverId",  "name email")
    .populate("l2ApproverId",  "name email")
    .lean();

  return { requests, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) };
};

// ─── APPROVE / REJECT ────────────────────────────────────────
exports.updateStatus = async (requestId, payload, user) => {
  const { action, comment } = payload;

  if (!["APPROVED", "REJECTED"].includes(action)) {
    throw new AppError("action must be APPROVED or REJECTED", 400);
  }

  const request = await AttendanceRegularization.findOne({
    _id:       toObjId(requestId),
    org_id:    toObjId(user.orgId),
    isDeleted: false,
  });
  if (!request) throw new AppError("Regularization request not found", 404);

  if (["APPROVED", "REJECTED", "CANCELLED", "APPLIED"].includes(request.status)) {
    throw new AppError(`Request already ${request.status.toLowerCase()}`, 400);
  }

  const isL1 = request.l1ApproverId && String(request.l1ApproverId) === String(user.userId);
  const isL2 = request.l2ApproverId && String(request.l2ApproverId) === String(user.userId);
  const isAdmin = ["unit_admin", "company_admin", "org_admin"].includes(user.role);

  // ── L1 Action ─────────────────────────────────────────────
  if (isL1 && request.status === "PENDING") {
    request.l1Status   = action;
    request.l1ActionAt = new Date();
    request.l1Comment  = comment || null;
    request.updatedBy  = toObjId(user.userId);

    request.approvalHistory.push({
      level:     1,
      actorId:   toObjId(user.userId),
      actorName: user.name  || "Approver",
      actorRole: user.role,
      action,
      comment:   comment || null,
      actionAt:  new Date(),
    });

    if (action === "REJECTED") {
      request.status = "REJECTED";
      await request.save();

      // Notify the employee
      Notification.create({
        org_id:  request.org_id,
        userId:  request.userId,
        type:    "REGULARIZATION_REJECTED",
        title:   "Regularisation Request Rejected",
        message: `Your regularisation request for ${new Date(request.date).toDateString()} has been rejected.`,
        meta:    { regularizationId: request._id },
      }).catch(() => {});

    } else if (request.l2ApproverId) {
      // L2 approval still required — forward the request
      request.status = "UNDER_REVIEW";
      await request.save();

      Notification.create({
        org_id:  request.org_id,
        userId:  request.l2ApproverId,
        type:    "REGULARIZATION_APPLIED",
        title:   "Regularisation Request Pending Your Approval",
        message: "A regularisation request is awaiting your approval.",
        meta:    { regularizationId: request._id },
      }).catch(() => {});

    } else {
      // No L2 approver assigned — true L1-only flow. Finalize directly instead
      // of leaving the request stuck at UNDER_REVIEW forever.
      request.status = "APPROVED";
      await request.save();

      await recalculateAttendance(request, user.userId);
      await triggerPayrollRecalculation(request, user.userId);

      request.isApplied = true;
      request.appliedAt = new Date();
      request.appliedBy = toObjId(user.userId);
      request.status    = "APPLIED";
      await request.save();

      Notification.create({
        org_id:  request.org_id,
        userId:  request.userId,
        type:    "REGULARIZATION_APPROVED",
        title:   "Regularisation Request Approved",
        message: `Your regularisation request for ${new Date(request.date).toDateString()} has been approved.`,
        meta:    { regularizationId: request._id },
      }).catch(() => {});
    }

    return request;
  }

  // ── L2 Action ─────────────────────────────────────────────
  if (isL2 && ["PENDING", "UNDER_REVIEW"].includes(request.status)) {
    request.l2Status   = action;
    request.l2ActionAt = new Date();
    request.l2Comment  = comment || null;
    request.updatedBy  = toObjId(user.userId);

    request.approvalHistory.push({
      level:     2,
      actorId:   toObjId(user.userId),
      actorName: user.name  || "Approver",
      actorRole: user.role,
      action,
      comment:   comment || null,
      actionAt:  new Date(),
    });

    if (action === "REJECTED") {
      request.status = "REJECTED";
      await request.save();

      Notification.create({
        org_id:  request.org_id,
        userId:  request.userId,
        type:    "REGULARIZATION_REJECTED",
        title:   "Regularisation Request Rejected",
        message: `Your regularisation request for ${new Date(request.date).toDateString()} has been rejected.`,
        meta:    { regularizationId: request._id },
      }).catch(() => {});

    } else {
      request.status = "APPROVED";
      await request.save();

      await recalculateAttendance(request, user.userId);
      await triggerPayrollRecalculation(request, user.userId);

      request.isApplied = true;
      request.appliedAt = new Date();
      request.appliedBy = toObjId(user.userId);
      request.status    = "APPLIED";
      await request.save();

      Notification.create({
        org_id:  request.org_id,
        userId:  request.userId,
        type:    "REGULARIZATION_APPROVED",
        title:   "Regularisation Request Approved",
        message: `Your regularisation request for ${new Date(request.date).toDateString()} has been approved.`,
        meta:    { regularizationId: request._id },
      }).catch(() => {});
    }

    return request;
  }

  // ── Admin Direct Action ────────────────────────────────────
  if (isAdmin) {
    request.l1Status   = action;
    request.l2Status   = action;
    request.l1ActionAt = new Date();
    request.l2ActionAt = new Date();
    request.updatedBy  = toObjId(user.userId);

    request.approvalHistory.push({
      level:     0,
      actorId:   toObjId(user.userId),
      actorName: user.name  || "Admin",
      actorRole: user.role,
      action,
      comment:   comment || null,
      actionAt:  new Date(),
    });

    if (action === "REJECTED") {
      request.status = "REJECTED";
      await request.save();

      Notification.create({
        org_id:  request.org_id,
        userId:  request.userId,
        type:    "REGULARIZATION_REJECTED",
        title:   "Regularisation Request Rejected",
        message: `Your regularisation request for ${new Date(request.date).toDateString()} has been rejected.`,
        meta:    { regularizationId: request._id },
      }).catch(() => {});

    } else {
      request.status = "APPROVED";
      await request.save();

      await recalculateAttendance(request, user.userId);
      await triggerPayrollRecalculation(request, user.userId);

      request.isApplied = true;
      request.appliedAt = new Date();
      request.appliedBy = toObjId(user.userId);
      request.status    = "APPLIED";
      await request.save();

      Notification.create({
        org_id:  request.org_id,
        userId:  request.userId,
        type:    "REGULARIZATION_APPROVED",
        title:   "Regularisation Request Approved",
        message: `Your regularisation request for ${new Date(request.date).toDateString()} has been approved.`,
        meta:    { regularizationId: request._id },
      }).catch(() => {});
    }

    return request;
  }

  throw new AppError("You are not authorized to take action on this request", 403);
};

// ─── CANCEL (Employee) ────────────────────────────────────────
exports.cancelRequest = async (requestId, user) => {
  let employee = await Employee.findOne({
    userId: toObjId(user.userId),
    org_id: toObjId(user.orgId),
  }).lean();
  if (!employee && user.email) {
    employee = await Employee.findOne({ email: user.email, org_id: toObjId(user.orgId) }).lean();
  }
  if (!employee) throw new AppError("Employee record not found", 404);

  const request = await AttendanceRegularization.findOne({
    _id:        toObjId(requestId),
    employeeId: employee._id,
    org_id:     toObjId(user.orgId),
    isDeleted:  false,
  });
  if (!request) throw new AppError("Request not found", 404);

  if (!["PENDING", "UNDER_REVIEW"].includes(request.status)) {
    throw new AppError(`Cannot cancel — request is already ${request.status}`, 400);
  }

  request.status    = "CANCELLED";
  request.updatedBy = toObjId(user.userId);
  await request.save();
  return request;
};