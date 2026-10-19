// modules/leave/leaveRequest.service.js
// REFACTORED — Dynamic Leave Management (Policy-Driven)
// Balance checks use active policy, not LeaveBalance collection

"use strict";
const notifService = require("../notification/notification.service");
const { sendNotification } = require("../../utils/sendNotification");

const mongoose     = require("mongoose");
const LeaveRequest = require("./models/leaveRequest.models");
const LeaveType    = require("./models/leaveType.models");
const Employee     = require("../employee/models/employee.model");
const User         = require("../auth/models/user.model");
const Role         = require("../role/role.model");
const AppError     = require("../../utils/appError");
const { sendEmail } = require("../../utils/email/email");
const {
  leaveApprovedTemplate,
  leaveRejectedTemplate,
  leavePendingTemplate,
} = require("../../utils/email/templates/leaveStatus");

const toObjId = (id) => new mongoose.Types.ObjectId(String(id));

// ─── Working days calculate (weekends excluded) ───────────────
const calcWorkingDays = (start, end) => {
  let count = 0;
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const endD = new Date(end);
  endD.setHours(0, 0, 0, 0);
  while (cur <= endD) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
};

// ─── Format date for emails ───────────────────────────────────
const fmtDate = (d) => {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

// ─── Resolve L1/L2 approvers from policy ─────────────────────
const resolveApprovers = async (employee, user, leavePolicy) => {
  const approvalType = leavePolicy?.approvalFlow?.type || "L1_L2";

  let l1ApproverId = null;
  let l2ApproverId = null;

  console.log('[resolveApprovers] Starting resolution:', {
    employeeId: employee._id,
    reportingManagerId: employee.reportingManagerId,
    approvalType,
    orgId: employee.org_id,
    companyId: employee.company_id,
    unitId: employee.unit_id
  });

  // L1 — Reporting Manager (if type is L1 or L1_L2)
  if (["L1", "L1_L2"].includes(approvalType)) {
    if (employee.reportingManagerId) {
      try {
        const managerEmployee = await Employee.findOne({
          _id: employee.reportingManagerId,
          isDeleted: false,
          status: "ACTIVE",
        }).select("userId name email").lean();

        console.log('[resolveApprovers] Manager employee found:', managerEmployee);

        if (managerEmployee?.userId) {
          const mgr = await User.findById(managerEmployee.userId)
            .select("_id name email status is_deleted");
          
          if (mgr && !mgr.is_deleted && mgr.status === "ACTIVE") {
            l1ApproverId = mgr._id;
            console.log('[resolveApprovers] L1 approver resolved:', {
              userId: mgr._id,
              name: mgr.name,
              email: mgr.email
            });
          } else {
            console.warn('[resolveApprovers] Manager user inactive or deleted:', mgr);
          }
        } else {
          console.warn('[resolveApprovers] Manager employee has no userId');
        }
      } catch (error) {
        console.error('[resolveApprovers] Error resolving L1 approver:', error);
      }
    } else {
      console.warn('[resolveApprovers] Employee has no reportingManagerId - will fallback to HR');
    }
  }

  // L2 — HR Manager in unit (if type is L1_L2 or no L1 found)
  // If L1 not found, L2 becomes the fallback approver
  if (approvalType === "L1_L2" || (approvalType === "L1" && !l1ApproverId)) {
    // Try multiple HR role slugs for flexibility
    const hrRoleSlugs = ["hr_manager", "company_hr_manager", "hr", "HR", "hr-admin"];
    let hrRole = null;

    for (const slug of hrRoleSlugs) {
      hrRole = await Role.findOne({ 
        $or: [
          { slug: slug },
          { name: slug.toLowerCase() },
          { name: slug.toUpperCase() }
        ],
        isSystem: true 
      }).select("_id name slug").lean();
      
      if (hrRole) {
        console.log('[resolveApprovers] Found HR role:', hrRole);
        break;
      }
    }

    if (hrRole) {
      // Try unit-level HR first
      if (employee.unit_id) {
        const hrUser = await User.findOne({
          org_id: employee.org_id,
          company_id: employee.company_id,
          unit_id: employee.unit_id,
          roleId: hrRole._id,
          is_deleted: false,
          status: "ACTIVE",
        }).select("_id name email").lean();

        if (hrUser) {
          l2ApproverId = hrUser._id;
          console.log('[resolveApprovers] L2 approver resolved (unit-level):', hrUser);
        }
      }

      // Fallback — company-level HR Manager
      if (!l2ApproverId) {
        const companyHrUser = await User.findOne({
          org_id: employee.org_id,
          company_id: employee.company_id,
          roleId: hrRole._id,
          is_deleted: false,
          status: "ACTIVE",
        }).select("_id name email").lean();

        if (companyHrUser) {
          l2ApproverId = companyHrUser._id;
          console.log('[resolveApprovers] L2 approver resolved (company-level):', companyHrUser);
        } else {
          console.warn('[resolveApprovers] No HR user found at unit or company level');
        }
      }
    } else {
      console.warn('[resolveApprovers] No HR role found with slugs:', hrRoleSlugs);
    }
  }

  // FALLBACK: If no L1 approver but L2 exists, use L2 as fallback approver
  // This ensures leave requests always have at least one approver
  if (!l1ApproverId && l2ApproverId) {
    console.log('[resolveApprovers] L1 unavailable - using L2 (HR) as fallback approver');
    l1ApproverId = l2ApproverId;
    l2ApproverId = null; // Clear L2 since we moved it to L1
  }

  // AUTO → no approver, auto-approve logic
  if (approvalType === "AUTO") {
    l1ApproverId = null;
    l2ApproverId = null;
  }

  return { l1ApproverId, l2ApproverId, approvalType };
};

// ─────────────────────────────────────────────────────────────────────────────
// T-11 + T-12 + T-13 + T-14 + T-15 + T-16
// APPLY LEAVE
// ─────────────────────────────────────────────────────────────────────────────

exports.applyLeave = async (payload, user) => {
  const {
    leaveTypeId, startDate, endDate,
    isHalfDay = false, session = null, remarks,reason,
  } = payload;

  // Find employee
  const employee = await Employee.findOne({
    userId:     user.userId,
    org_id:     user.orgId,
    company_id: user.companyId,
    isDeleted:  false,
  }).select("name email employeeId org_id company_id unit_id reportingManagerId status gender employmentType");

  if (!employee) throw new AppError("Employee record not found for your account", 404);
  if (employee.status === "TERMINATED") throw new AppError("Terminated employees cannot apply for leave", 400);

  // Leave type check
  const leaveType = await LeaveType.findOne({
    _id:        leaveTypeId,
    company_id: user.companyId,
    isActive:   true,
    isDeleted:  false,
  });
  if (!leaveType) throw new AppError("Leave type not found or inactive", 404);

  // T-14 — Gender validation
  if (leaveType.applicableGender && leaveType.applicableGender !== "ALL") {
    if (employee.gender && employee.gender !== leaveType.applicableGender) {
      throw new AppError(
        `${leaveType.name} is only applicable for ${leaveType.applicableGender} employees`,
        400
      );
    }
  }

  // T-15 — Employment type validation
  if (leaveType.applicableEmploymentTypes && leaveType.applicableEmploymentTypes.length > 0) {
    if (employee.employmentType && !leaveType.applicableEmploymentTypes.includes(employee.employmentType)) {
      throw new AppError(
        `${leaveType.name} is not applicable for ${employee.employmentType} employees`,
        400
      );
    }
  }

  const start = new Date(startDate);
  const end   = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  // T-13 — Past date validation (same day allowed)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (start < today) {
    throw new AppError("Cannot apply leave for past dates. Same day application is allowed.", 400);
  }

  if (end < start) throw new AppError("End date cannot be before start date", 400);

  // Total days calculate
  let totalDays;
  if (isHalfDay) {
    if (!session) throw new AppError("session (FIRST_HALF/SECOND_HALF) required for half day", 400);
    if (start.getTime() !== end.getTime()) throw new AppError("Start and end date must be same for half day", 400);
    totalDays = 0.5;
  } else {
    totalDays = calcWorkingDays(start, end);
    if (totalDays === 0) throw new AppError("No working days in selected date range", 400);
  }

  // Min notice days check
  const noticeDays = Math.ceil((start - today) / (1000 * 60 * 60 * 24));
  if (leaveType.minNoticeDays > 0 && noticeDays < leaveType.minNoticeDays) {
    throw new AppError(`This leave type requires ${leaveType.minNoticeDays} day(s) advance notice`, 400);
  }

  // Max consecutive days check
  if (leaveType.maxConsecutiveDays > 0 && !isHalfDay && totalDays > leaveType.maxConsecutiveDays) {
    throw new AppError(`Maximum ${leaveType.maxConsecutiveDays} consecutive days allowed for ${leaveType.name}`, 400);
  }

  // Overlap check
  const overlap = await LeaveRequest.findOne({
    employeeId: employee._id,
    status:     { $in: ["PENDING", "UNDER_REVIEW", "APPROVED"] },
    startDate:  { $lte: end },
    endDate:    { $gte: start },
  });
  if (overlap) throw new AppError("You already have a leave request for overlapping dates", 409);

  // ─── DYNAMIC BALANCE CHECK (Policy-Driven) ────────────────────────────────
  const isLOP = leaveType.code === "LOP" || leaveType.isPaid === false;
  let balanceInfo = null; // Track balance for snapshot

   {
    // Use dynamic balance calculation from active policy
    const { getActiveLeavePolicy, calculateLeaveUsage } = require("./leave.service");
    const { earnedCredits, daysInYear } = require('./leaveAccounting');
    const year = start.getUTCFullYear();

    const activePolicy = await getActiveLeavePolicy(
      employee.org_id,
      employee.company_id,
      employee.unit_id
    );

    if (!activePolicy) {
      throw new AppError("No active leave policy found for your unit. Please contact HR.", 400);
    }

    // Find the leave type allocation in policy
    const policyLeaveType = activePolicy.leaveTypes.find(
      (plt) => plt.isActive && (plt.leaveTypeId?.toString() === leaveTypeId.toString() || plt.code === leaveType.code)
    );

    if (!policyLeaveType) {
      throw new AppError(
        `Leave type "${leaveType.name}" is not configured in the active leave policy. Please contact HR.`,
        400
      );
    }

    // Calculate usage dynamically
    const allocated = earnedCredits(policyLeaveType.credit, year, start, employee.joiningDate);
    const usage = await calculateLeaveUsage(employee._id, leaveTypeId, year);
    const remaining = allocated - usage.used - usage.pending +
      (policyLeaveType.balance?.allowNegative ? policyLeaveType.balance.maxNegative || 0 : 0);

    if (remaining < daysInYear({ startDate: start, endDate: end, totalDays }, year)) {
      throw new AppError(
        `Insufficient leave balance. Available: ${remaining} day(s), Requested: ${totalDays} day(s)`,
        400
      );
    }

    if (end.getUTCFullYear() !== year) {
      const nextYear = end.getUTCFullYear();
      const nextUsage = await calculateLeaveUsage(employee._id, leaveTypeId, nextYear);
      const nextAllocation = earnedCredits(policyLeaveType.credit, nextYear, end, employee.joiningDate);
      const nextAvailable = nextAllocation - nextUsage.used - nextUsage.pending +
        (policyLeaveType.balance?.allowNegative ? policyLeaveType.balance.maxNegative || 0 : 0);
      if (nextAvailable < daysInYear({ startDate: start, endDate: end, totalDays }, nextYear)) {
        throw new AppError(`Insufficient leave balance for ${nextYear}`, 400);
      }
    }

    // Store balance snapshot for record-keeping
    balanceInfo = {
      totalAllocated: allocated,
      used: usage.used,
      pending: usage.pending,
      remaining: remaining
    };
  }

  // T-12 — Resolve approvers from LeavePolicy
  let leavePolicy = null;
  try {
    const { resolveLeavePolicy } = require("../../utils/policyResolver");
    leavePolicy = await resolveLeavePolicy(
      employee._id.toString(),
      user.companyId.toString(),
      employee.unit_id ? employee.unit_id.toString() : null
    );
  } catch (e) {
    // No leave policy configured — default to L1_L2
  }

  const { l1ApproverId, l2ApproverId, approvalType } = await resolveApprovers(employee, user, leavePolicy);

  // ═══════════════════════════════════════════════════════════════════════════
  // ENTERPRISE COMPLIANCE: Validate approvers exist for admin users
  // ═══════════════════════════════════════════════════════════════════════════
  // Prevent admins from creating leave requests with no approvers
  // This avoids self-approval compliance violations
  
  const isAdminUser = ["org_admin", "company_admin", "SUPER_ADMIN"].includes(user.role);
  
  if (isAdminUser && approvalType !== "AUTO") {
    console.log('[applyLeave] Admin user detected, validating approvers:', {
      userRole: user.role,
      userId: user.userId,
      l1ApproverId,
      l2ApproverId,
      approvalType
    });
    
    // If no approvers assigned, check if HR Manager exists in the system
    if (!l1ApproverId && !l2ApproverId) {
      console.warn('[applyLeave] No approvers assigned for admin user');
      
      // Find HR role in the system
      const hrRoleSlugs = ["hr_manager", "company_hr_manager", "unit_admin", "hr", "HR", "hr-admin"];
      let hrRole = null;
      
      for (const slug of hrRoleSlugs) {
        hrRole = await Role.findOne({ 
          $or: [
            { slug: slug },
            { name: slug.toLowerCase() },
            { name: slug.toUpperCase() }
          ],
          isSystem: true 
        }).select("_id name slug").lean();
        
        if (hrRole) {
          console.log('[applyLeave] Found HR role:', hrRole);
          break;
        }
      }
      
      if (!hrRole) {
        throw new AppError(
          "Cannot apply for leave: No HR role found in the system. " +
          "Please contact system administrator to create an HR role first.",
          400
        );
      }
      
      // Check if any HR Manager user exists in the organization
      const hrUserCount = await User.countDocuments({
        org_id: user.orgId,
        roleId: hrRole._id,
        is_deleted: false,
        status: "ACTIVE"
      });
      
      console.log('[applyLeave] HR user count:', hrUserCount);
      
      if (hrUserCount === 0) {
        throw new AppError(
          "Cannot apply for leave: No HR Manager found in your organization. " +
          "As an administrator, you must have at least one HR Manager designated to approve your leave request. " +
          "Please create an HR Manager user first, or assign a reporting manager to your employee profile.",
          400
        );
      }
      
      // HR exists but wasn't auto-assigned - this shouldn't happen, but handle gracefully
      console.warn('[applyLeave] HR users exist but no approver assigned - configuration issue');
    }
  }

  // NOTE: Balance updates removed - balances are calculated dynamically at query time
  // from LeaveRequest records (PENDING + APPROVED statuses)

  // Determine initial status
  let initialStatus = "PENDING";
  if (approvalType === "AUTO") initialStatus = "APPROVED";

  // Create leave request
  const leaveRequest = await LeaveRequest.create({
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    employee.unit_id || user.unitId || null,
    employeeId: employee._id,
    userId:     user.userId,
    leaveTypeId,
    startDate:  start,
    endDate:    end,
    isHalfDay,
    session:    isHalfDay ? session : null,
    totalDays,
    reason:     remarks || reason || "No reason provided",
    status:     initialStatus,
    l1ApproverId,
    l1Status:   l1ApproverId ? "PENDING" : null,
    l2ApproverId,
    l2Status:   l2ApproverId ? "PENDING" : null,
    isBalanceDeducted: approvalType === "AUTO",
    balanceAtRequest: balanceInfo ? {
      totalAllocated: balanceInfo.totalAllocated,
      used:           balanceInfo.used,
      remaining:      balanceInfo.remaining,
    } : null,
    createdBy: user.userId,
  });

  await leaveRequest.populate("leaveTypeId", "name code colorCode");

  // T-31 — Notify L1 approver (if set)
  if (l1ApproverId) {
    try {
      const approver = await User.findById(l1ApproverId).select("name email");
      if (approver?.email) {
        await sendEmail({
          to:      approver.email,
          subject: `Leave Approval Required — ${employee.name}`,
          html:    leavePendingTemplate({
            approverName: approver.name || "Manager",
            employeeName: employee.name,
            leaveType:    leaveType.name,
            startDate:    fmtDate(start),
            endDate:      fmtDate(end),
            totalDays,
            reason:       remarks,
          }),
        });
      }
    } catch (e) {
      console.error("Leave notification email failed:", e.message);
    }
  }

  // ════════════════════════════════════════════════════════════
  // ENHANCED NOTIFICATION SYSTEM - NOTIFY ALL STAKEHOLDERS
  // ════════════════════════════════════════════════════════════
  // When employee applies for leave:
  // 1. L1 (Reporting Manager) - Primary approver
  // 2. L2 (HR Manager) - Secondary approver
  // 3. Admin (org_admin/company_admin) - Oversight
  
  const notifyUserIds = new Set();
  const notificationPromises = [];
  
  // 1. Notify L1 Approver (Reporting Manager)
  if (l1ApproverId) {
    notifyUserIds.add(String(l1ApproverId));
    notificationPromises.push(
      (async () => {
        try {
          const notifResult = await sendNotification({
            type:          "LEAVE_APPLIED",
            userId:        l1ApproverId,
            org_id:        user.orgId,
            unit_id:       user.unitId,
            referenceId:   leaveRequest._id,
            referenceType: "LeaveRequest",
            data: {
              employeeName: employee.name,
              leaveType:    leaveType?.code || "Leave",
              startDate:    fmtDate(start),
              endDate:      fmtDate(end),
              totalDays,
              leaveId:      leaveRequest._id,
              priority:     "HIGH",
            },
            inApp:  true,
            email:  false,
            push:   true
          });
          
          if (notifResult?.inApp?.success) {
            console.log('[applyLeave] ✅ Notification sent to L1 approver:', l1ApproverId);
          } else {
            console.error('[applyLeave] ⚠️ L1 notification failed:', JSON.stringify(notifResult, null, 2));
          }
        } catch (err) {
          console.error('[applyLeave] ❌ L1 notification exception:', err.message);
        }
      })()
    );
  }
  
  // 2. Notify L2 Approver (HR Manager) - If different from L1
  if (l2ApproverId && !notifyUserIds.has(String(l2ApproverId))) {
    notifyUserIds.add(String(l2ApproverId));
    notificationPromises.push(
      (async () => {
        try {
          const notifResult = await sendNotification({
            type:          "LEAVE_APPLIED",
            userId:        l2ApproverId,
            org_id:        user.orgId,
            unit_id:       user.unitId,
            referenceId:   leaveRequest._id,
            referenceType: "LeaveRequest",
            data: {
              employeeName: employee.name,
              leaveType:    leaveType?.code || "Leave",
              startDate:    fmtDate(start),
              endDate:      fmtDate(end),
              totalDays,
              leaveId:      leaveRequest._id,
              priority:     "MEDIUM",
              note:         "For your information - pending L1 approval",
            },
            inApp:  true,
            email:  false,
            push:   true
          });
          
          if (notifResult?.inApp?.success) {
            console.log('[applyLeave] ✅ Notification sent to L2 (HR):', l2ApproverId);
          } else {
            console.error('[applyLeave] ⚠️ L2 notification failed:', JSON.stringify(notifResult, null, 2));
          }
        } catch (err) {
          console.error('[applyLeave] ❌ L2 notification exception:', err.message);
        }
      })()
    );
  }
  
  // 3. Notify Admin Users (org_admin, company_admin) - For oversight
  const adminUsers = await User.find({
    org_id: user.orgId,
    role: { $in: ["org_admin", "company_admin", "SUPER_ADMIN"] },
    status: "ACTIVE",
    is_deleted: false
  }).select("_id").lean();
  
  for (const admin of adminUsers) {
    const adminId = String(admin._id);
    if (!notifyUserIds.has(adminId)) {
      notifyUserIds.add(adminId);
      notificationPromises.push(
        (async () => {
          try {
            const notifResult = await sendNotification({
              type:          "LEAVE_APPLIED",
              userId:        adminId,
              org_id:        user.orgId,
              unit_id:       user.unitId,
              referenceId:   leaveRequest._id,
              referenceType: "LeaveRequest",
              data: {
                employeeName: employee.name,
                leaveType:    leaveType?.code || "Leave",
                startDate:    fmtDate(start),
                endDate:      fmtDate(end),
                totalDays,
                leaveId:      leaveRequest._id,
                priority:     "LOW",
                note:         "For your oversight",
              },
              inApp:  true,
              email:  false,
              push:   false  // Don't push notify admins
            });
            
            if (notifResult?.inApp?.success) {
              console.log('[applyLeave] ✅ Notification sent to Admin:', adminId);
            }
          } catch (err) {
            console.error('[applyLeave] ❌ Admin notification exception:', err.message);
          }
        })()
      );
    }
  }
  
  // Wait for all notifications to complete
  await Promise.allSettled(notificationPromises);
  console.log(`[applyLeave] ✅ Total stakeholders notified: ${notifyUserIds.size}`);
  
  if (!l1ApproverId && !l2ApproverId) {
    console.warn('[applyLeave] ⚠️ No L1/L2 approver available - only admin notified.');
  }

  return leaveRequest;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL LEAVE REQUESTS
// ─────────────────────────────────────────────────────────────────────────────

exports.getAllLeaveRequests = async (query, user) => {
  const { 
    status, 
    employeeId, 
    departmentId,
    leaveTypeId,
    startDate,
    endDate,
    page = 1, 
    limit = 10 
  } = query;

  const filter = {
    org_id:     user.orgId,
    company_id: user.companyId,
  };

  // Role-based scope
  if (user.role === "employee" || user.role === "manager") {
    const emp = await Employee.findOne({
      userId:     user.userId,
      org_id:     user.orgId,
      company_id: user.companyId,
      isDeleted:  false,
    }).select("_id");
    if (emp) filter.employeeId = emp._id;
  } else {
    if (user.unitId)  filter.unit_id    = user.unitId;
    
    // BR-17: employee and department filters work together (AND).
    // Before, an employee filter was ignored whenever a department was selected.
    const empty = { requests: [], pagination: { total: 0, page: Number(page), limit: Number(limit), pages: 0 } };
    if (departmentId) {
      const deptEmployees = await Employee.find({ 
        departmentId: toObjId(departmentId),
        org_id: user.orgId,
        company_id: user.companyId,
        isDeleted: false 
      }).distinct('_id');

      const ids = employeeId
        ? deptEmployees.filter(id => String(id) === String(employeeId))
        : deptEmployees;
      if (!ids.length) return empty;
      filter.employeeId = { $in: ids };
    } else if (employeeId) {
      filter.employeeId = toObjId(employeeId);
    }
  }

  // Status filter
  if (status) filter.status = status;

  // Leave Type filter
  if (leaveTypeId) {
    filter.leaveTypeId = toObjId(leaveTypeId);
  }

  // Date range filter
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    filter.startDate = { $gte: start };
    filter.endDate = { $lte: end };
  }

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await LeaveRequest.countDocuments(filter);

  const requests = await LeaveRequest.find(filter)
    .populate("employeeId", "name employeeId email profilePhoto")
    .populate("leaveTypeId",  "name code colorCode")
    .populate("l1ApproverId", "name email")
    .populate("l2ApproverId", "name email")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  return {
    requests,
    pagination: {
      total,
      page:  Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ONE LEAVE REQUEST
// ─────────────────────────────────────────────────────────────────────────────

exports.getLeaveRequestById = async (id, user) => {
  const request = await LeaveRequest.findOne({
    _id:        id,
    org_id:     user.orgId,
    company_id: user.companyId,
  })
    .populate("employeeId", "name employeeId email profilePhoto")
    .populate("leaveTypeId",  "name code colorCode")
    .populate("l1ApproverId", "name email")
    .populate("l2ApproverId", "name email");

  if (!request) throw new AppError("Leave request not found", 404);
  return request;
};

// ─────────────────────────────────────────────────────────────────────────────
// T-12 — APPROVE / REJECT (L1/L2 flow)
// PATCH /api/v1/leave/:id
// ─────────────────────────────────────────────────────────────────────────────

exports.updateLeaveStatus = async (id, payload, user) => {
  const { status, remarks } = payload;

  if (!["APPROVED", "REJECTED", "UNDER_REVIEW"].includes(status)) {
    throw new AppError("Invalid status. Use APPROVED, REJECTED, or UNDER_REVIEW", 400);
  }

  const filter = { _id: id, org_id: user.orgId };
  if (user.companyId) filter.company_id = user.companyId;

  const request = await LeaveRequest.findOne(filter)
    .populate("employeeId", "name email profilePhoto");

  if (!request) throw new AppError("Leave request not found", 404);

  if (!["PENDING", "UNDER_REVIEW"].includes(request.status)) {
    throw new AppError(`Cannot update — request is already ${request.status}`, 400);
  }

  const isSuperAdmin   = user.role === "SUPER_ADMIN";
  const isOrgAdmin     = user.role === "org_admin";
  const isCompanyAdmin = user.role === "company_admin";
  const isHRManager    = ["hr_manager", "company_hr_manager", "unit_admin"].includes(user.role);
  const isL1           = request.l1ApproverId && String(request.l1ApproverId) === String(user.userId);
  const isL2           = request.l2ApproverId && String(request.l2ApproverId) === String(user.userId);

  // ── ROLE & PERMISSION RESOLUTION ───────────────────────────────
  const isHRManagerExtended = ["hr_manager", "company_hr_manager", "unit_admin", "hr", "HR", "hr-admin"].includes(user.role);
  
  // Check if user is in admin hierarchy (can bypass approvals)
  const isAdminLevel = isSuperAdmin || isOrgAdmin || isCompanyAdmin;
  
  // ── APPROVER ID VALIDATION ─────────────────────────────────────
  // Normalize IDs for comparison - handle both ObjectId and String
  const normalizeId = (id) => id ? String(id) : null;
  const currentUserId = normalizeId(user.userId);
  const requestL1Approver = normalizeId(request.l1ApproverId);
  const requestL2Approver = normalizeId(request.l2ApproverId);
  
  console.log('[updateLeaveStatus] Authorization check:', {
    userId: currentUserId,
    userRole: user.role,
    isSuperAdmin,
    isOrgAdmin,
    isCompanyAdmin,
    isHRManager: isHRManagerExtended,
    isAdminLevel,
    isL1,
    isL2,
    requestStatus: request.status,
    l1Status: request.l1Status,
    l2Status: request.l2Status,
    requestL1Approver,
    requestL2Approver,
    hasL1Approver: !!requestL1Approver,
    hasL2Approver: !!requestL2Approver
  });

  // ── CUSTOM ROLE PERMISSION CHECK ─────────────────────────────────
  let hasLeaveApprove = false;
  let hasLeaveApproveL1 = false;
  let hasLeaveApproveL2 = false;
  
  try {
    if (user.roleId) {
      const userRole = await Role.findById(user.roleId).populate("permissions").lean();
      hasLeaveApprove   = userRole?.permissions?.some(p => p.slug === "leave.approve") || false;
      hasLeaveApproveL1 = userRole?.permissions?.some(p => p.slug === "leave.approve.l1" || p.slug === "leave.approve") || false;
      hasLeaveApproveL2 = userRole?.permissions?.some(p => p.slug === "leave.approve.l2" || p.slug === "leave.approve") || false;
    }
  } catch (err) {
    console.error('[updateLeaveStatus] Permission check error:', err);
  }

  // ── AUTHORIZATION DECISION TREE ─────────────────────────────────
  // Enterprise-grade approval flow with multiple fallback paths
  
  let canL1Act = false;
  let canL2Act = false;
  let bypassL1 = false;
  let bypassL2 = false;
  let authReason = "";

  // ════════════════════════════════════════════════════════════
  // SELF-APPROVAL PREVENTION: Compliance requirement
  // ════════════════════════════════════════════════════════════
  const isOwnRequest = normalizeId(request.userId) === currentUserId;
  
  if (isOwnRequest && !isSuperAdmin) {
    console.warn('[updateLeaveStatus] Self-approval blocked:', {
      requestUserId: normalizeId(request.userId),
      currentUserId,
      userRole: user.role
    });
    
    throw new AppError(
      "Cannot approve your own leave request. This violates separation of duties and audit compliance. " +
      "Please ask another authorized person (HR Manager or Admin) to approve your request.",
      403
    );
  }
  
  // ════════════════════════════════════════════════════════════
  // ADMIN BYPASS: Super Admin, Org Admin, Company Admin can approve at any level
  // ════════════════════════════════════════════════════════════
  // Exception: SUPER_ADMIN can self-approve ONLY in emergency situations
  if (isAdminLevel) {
    if (request.status === "PENDING") {
      canL1Act = true;
      bypassL1 = true;
      authReason = isOwnRequest ? "Admin self-approval (SUPER_ADMIN emergency override)" : "Admin bypass - L1";
      console.log('[updateLeaveStatus] Admin bypass activated for L1', {
        isOwnRequest,
        userRole: user.role
      });
    } else if (request.status === "UNDER_REVIEW") {
      canL2Act = true;
      bypassL2 = true;
      authReason = isOwnRequest ? "Admin self-approval (SUPER_ADMIN emergency override)" : "Admin bypass - L2";
      console.log('[updateLeaveStatus] Admin bypass activated for L2', {
        isOwnRequest,
        userRole: user.role
      });
    }
  }
  
  // ════════════════════════════════════════════════════════════
  // L1 APPROVAL AUTHORIZATION
  // ════════════════════════════════════════════════════════════
  if (!canL1Act && request.status === "PENDING" && (request.l1Status === "PENDING" || request.l1Status === null)) {
    console.log('[updateLeaveStatus] Checking L1 authorization...');
    
    // Priority 1: User is designated L1 approver
    if (isL1) {
      canL1Act = true;
      authReason = "Designated L1 approver";
      console.log('[updateLeaveStatus] ✓ Authorized as designated L1 approver');
    }
    // Priority 2: User has explicit L1 approval permission
    else if (hasLeaveApproveL1) {
      canL1Act = true;
      authReason = "Has leave.approve.l1 permission";
      console.log('[updateLeaveStatus] ✓ Authorized via permission');
    }
    // Priority 3: HR Manager can approve L1 if no L1 assigned or as backup
    else if (isHRManagerExtended) {
      canL1Act = true;
      authReason = "HR Manager (L1 backup)";
      console.log('[updateLeaveStatus] ✓ Authorized as HR Manager');
    }
    // Priority 4: Global approval permission
    else if (hasLeaveApprove) {
      canL1Act = true;
      authReason = "Has leave.approve permission";
      console.log('[updateLeaveStatus] ✓ Authorized via global permission');
    }
  }
  
  // ════════════════════════════════════════════════════════════
  // L2 APPROVAL AUTHORIZATION  
  // ════════════════════════════════════════════════════════════
  if (!canL2Act && request.status === "UNDER_REVIEW" && (request.l2Status === "PENDING" || request.l2Status === null)) {
    console.log('[updateLeaveStatus] Checking L2 authorization...');
    
    // Priority 1: User is designated L2 approver
    if (isL2) {
      canL2Act = true;
      authReason = "Designated L2 approver";
      console.log('[updateLeaveStatus] ✓ Authorized as designated L2 approver');
    }
    // Priority 2: HR Manager can approve L2
    else if (isHRManagerExtended) {
      canL2Act = true;
      authReason = "HR Manager (L2 authority)";
      console.log('[updateLeaveStatus] ✓ Authorized as HR Manager');
    }
    // Priority 3: User has explicit L2 approval permission
    else if (hasLeaveApproveL2) {
      canL2Act = true;
      authReason = "Has leave.approve.l2 permission";
      console.log('[updateLeaveStatus] ✓ Authorized via L2 permission');
    }
    // Priority 4: Global approval permission
    else if (hasLeaveApprove) {
      canL2Act = true;
      authReason = "Has leave.approve permission";
      console.log('[updateLeaveStatus] ✓ Authorized via global permission');
    }
  }
  
  // ════════════════════════════════════════════════════════════
  // DIRECT APPROVAL PATH (No L2 approver exists)
  // ════════════════════════════════════════════════════════════
  if (!canL2Act && request.status === "UNDER_REVIEW" && !requestL2Approver) {
    console.log('[updateLeaveStatus] Direct approval path - no L2 approver exists');
    if (canL1Act || isL1 || isHRManagerExtended || hasLeaveApprove) {
      canL2Act = true;
      bypassL2 = true;
      authReason = "Direct approval (no L2 configured)";
      console.log('[updateLeaveStatus] ✓ Direct approval authorized');
    }
  }

  // ════════════════════════════════════════════════════════════
  // EMERGENCY FALLBACK: Same-company/org approval for urgent cases
  // ════════════════════════════════════════════════════════════
  if (!canL1Act && !canL2Act && !requestL1Approver && !requestL2Approver) {
    console.log('[updateLeaveStatus] Emergency fallback - no approvers assigned');
    if (isHRManagerExtended || hasLeaveApprove) {
      if (request.status === "PENDING") {
        canL1Act = true;
        authReason = "Emergency fallback - no approvers configured";
      } else if (request.status === "UNDER_REVIEW") {
        canL2Act = true;
        authReason = "Emergency fallback - no approvers configured";
      }
      console.log('[updateLeaveStatus] ✓ Emergency fallback activated');
    }
  }

  const canAct = canL1Act || canL2Act;

  console.log('[updateLeaveStatus] Final authorization result:', {
    canL1Act,
    canL2Act,
    canAct,
    bypassL1,
    bypassL2,
    authReason
  });

  if (!canAct) {
    const errorDetails = [
      `Status: ${request.status}`,
      `L1 Approver: ${requestL1Approver || 'Not assigned'}`,
      `L2 Approver: ${requestL2Approver || 'Not assigned'}`,
      `Your User ID: ${currentUserId}`,
      `Your Role: ${user.role}`,
      `Is HR Manager: ${isHRManagerExtended}`,
      `Has Permission: ${hasLeaveApprove}`
    ].join(', ');
    
    throw new AppError(
      `You are not authorized to act on this leave request. Details: ${errorDetails}`,
      403
    );
  }

  // ── APPROVAL LOGIC ─────────────────────────────────────────────────
  // Enterprise-grade state machine with proper L1/L2 flow handling
  
  if (status === "APPROVED") {
    // ─── L1 APPROVAL PATH ───────────────────────────────────────
    if (canL1Act && request.status === "PENDING") {
      request.l1Status   = "APPROVED";
      request.l1ActionAt = new Date();
      request.l1Comment  = remarks || null;
      request.l1ApproverId = request.l1ApproverId || user.userId; // Ensure approver is recorded
      
      // Check if L2 approval is required
      if (requestL2Approver && !bypassL2) {
        // Forward to L2
        request.status = "UNDER_REVIEW";
        console.log('[updateLeaveStatus] L1 approved - forwarded to L2');
      } else {
        // Direct approval (no L2 or bypass)
        request.status = "APPROVED";
        request.l2Status = "APPROVED";
        request.l2ActionAt = new Date();
        request.l2Comment = remarks || null;
        console.log('[updateLeaveStatus] Direct approval - no L2 required');
      }
    }
    // ─── L2 APPROVAL PATH ───────────────────────────────────────
    else if (canL2Act && request.status === "UNDER_REVIEW") {
      request.status     = "APPROVED";
      request.l2Status   = "APPROVED";
      request.l2ActionAt = new Date();
      request.l2Comment  = remarks || null;
      request.l2ApproverId = request.l2ApproverId || user.userId; // Ensure approver is recorded
      console.log('[updateLeaveStatus] L2 approved - request finalized');
    }
    // ─── ADMIN BYPASS APPROVAL ───────────────────────────────────
    else if (bypassL1 || bypassL2) {
      request.status = "APPROVED";
      if (request.status !== "UNDER_REVIEW") {
        request.l1Status   = request.l1Status || "APPROVED";
        request.l1ActionAt = request.l1ActionAt || new Date();
        request.l1Comment  = request.l1Comment || remarks || null;
      }
      request.l2Status   = "APPROVED";
      request.l2ActionAt = new Date();
      request.l2Comment  = remarks || null;
      console.log('[updateLeaveStatus] Admin bypass approval');
    }
    // ─── FALLBACK: Auto-determine approval level ───────────────
    else {
      console.log('[updateLeaveStatus] Fallback approval path');
      request.status = "APPROVED";
      
      // Set appropriate approval status based on current state
      if (request.status === "PENDING" || request.l1Status === "PENDING" || request.l1Status === null) {
        request.l1Status   = "APPROVED";
        request.l1ActionAt = new Date();
        request.l1Comment  = remarks || null;
      }
      if (request.l2Status === "PENDING" || request.l2Status === null || request.status === "UNDER_REVIEW") {
        request.l2Status   = "APPROVED";
        request.l2ActionAt = new Date();
        request.l2Comment  = remarks || null;
      }
    }
  }
  // ─── REJECTION HANDLING ─────────────────────────────────────────────
  else if (status === "REJECTED") {
    request.status = "REJECTED";
    
    // L1 Rejection - reject entirely
    if (canL1Act && (request.status === "PENDING" || !request.l1ActionAt)) {
      request.l1Status   = "REJECTED";
      request.l1ActionAt = new Date();
      request.l1Comment  = remarks || null;
      request.l1ApproverId = request.l1ApproverId || user.userId;
      console.log('[updateLeaveStatus] Rejected at L1 level');
    }
    
    // L2 Rejection - reject entirely (even if L1 approved)
    if (canL2Act && (request.status === "UNDER_REVIEW" || bypassL2)) {
      request.l2Status   = "REJECTED";
      request.l2ActionAt = new Date();
      request.l2Comment  = remarks || null;
      request.l2ApproverId = request.l2ApproverId || user.userId;
      
      // Ensure L1 status is set if bypassing
      if (!request.l1ActionAt) {
        request.l1Status   = "APPROVED"; // Mark as approved to show it went through L1
        request.l1ActionAt = new Date();
        request.l1Comment  = "Auto-approved (bypass)";
      }
      console.log('[updateLeaveStatus] Rejected at L2 level');
    }
    
    // Admin/Manager rejection with bypass
    if (bypassL1 || bypassL2) {
      if (!request.l1ActionAt) {
        request.l1Status   = "REJECTED";
        request.l1ActionAt = new Date();
        request.l1Comment  = remarks || null;
      }
      if (!request.l2ActionAt) {
        request.l2Status   = "REJECTED";
        request.l2ActionAt = new Date();
        request.l2Comment  = remarks || null;
      }
    }
  }

  // Audit history
  request.approvalHistory.push({
    level:        canL1Act ? 1 : 2,
    approverId:   user.userId,
    approverName: user.name || "Approver",
    approverRole: user.role,
    action:       status,
    comment:      remarks || null,
    actionAt:     new Date(),
  });

  request.updatedBy = user.userId;
  await request.save();

  // ════════════════════════════════════════════════════════════
  // ENHANCED NOTIFICATION - L1 APPROVED & FORWARDED TO L2
  // ════════════════════════════════════════════════════════════
  // Notify: 1) L2 (HR) - Needs to approve
  //        2) Employee - Status updated to UNDER_REVIEW
  //        3) Admin - Oversight
  //        4) L1 - Confirmation (optional)
  
  const employeeName  = request.employeeId?.name || "Employee";
  const employeeEmail = request.employeeId?.email;
  const leaveTypeDoc = await LeaveType.findById(request.leaveTypeId).select("name code");
  
  const notificationPromises = [];
  
  // 1. Notify L2 (HR Manager) - Primary action needed
  if (request.status === "UNDER_REVIEW" && request.l2ApproverId) {
    // Email to L2
    try {
      const l2Approver = await User.findById(request.l2ApproverId).select("name email");
      if (l2Approver?.email) {
        await sendEmail({
          to:      l2Approver.email,
          subject: `Leave Request Pending Your Approval — ${employeeName}`,
          html:    leavePendingTemplate({
            approverName: l2Approver.name || "Manager",
            employeeName: employeeName,
            leaveType:    leaveTypeDoc?.name || "Leave",
            startDate:    fmtDate(request.startDate),
            endDate:      fmtDate(request.endDate),
            totalDays:    request.totalDays,
            reason:       request.reason || "",
          }),
        });
        console.log(`[updateLeaveStatus] ✅ Email sent to L2 approver: ${l2Approver.email}`);
      }
    } catch (e) {
      console.error("[L2 Email] Failed:", e.message);
    }
    
    // In-App + Push to L2
    notificationPromises.push(
      (async () => {
        try {
          const notifResult = await sendNotification({
            type:          "LEAVE_APPLIED",
            userId:        request.l2ApproverId,
            org_id:        request.org_id,
            unit_id:       request.unit_id,
            referenceId:   request._id,
            referenceType: "LeaveRequest",
            data: {
              employeeName: employeeName,
              leaveType:    leaveTypeDoc?.name || "Leave",
              startDate:    fmtDate(request.startDate),
              endDate:      fmtDate(request.endDate),
              totalDays:    request.totalDays,
              leaveId:      request._id,
              forwardedBy:  user.name || "L1 Approver",
              priority:     "HIGH",
            },
            inApp:  true,
            email:  false,
            push:   true
          });
          
          if (notifResult?.inApp?.success) {
            console.log(`[updateLeaveStatus] ✅ Notification sent to L2: ${request.l2ApproverId}`);
          } else {
            console.error(`[updateLeaveStatus] ⚠️ L2 notification failed:`, notifResult);
          }
        } catch (err) {
          console.error("[L2 Notification] Exception:", err.message);
        }
      })()
    );
  }
  
  // 2. Notify Employee - Status updated to UNDER_REVIEW
  if (request.status === "UNDER_REVIEW") {
    notificationPromises.push(
      (async () => {
        try {
          const notifResult = await sendNotification({
            type:          "LEAVE_UNDER_REVIEW",
            userId:        request.userId,
            org_id:        request.org_id,
            unit_id:       request.unit_id,
            referenceId:   request._id,
            referenceType: "LeaveRequest",
            data: {
              employeeName: employeeName,
              leaveType:    leaveTypeDoc?.name || "Leave",
              startDate:    fmtDate(request.startDate),
              endDate:      fmtDate(request.endDate),
              totalDays:    request.totalDays,
              leaveId:      request._id,
              status:       "UNDER_REVIEW",
              approvedBy:   user.name || "L1 Approver",
              message:      "Your leave request has been approved by L1 and forwarded to HR for final approval.",
            },
            inApp:  true,
            email:  false,
            push:   true
          });
          
          if (notifResult?.inApp?.success) {
            console.log(`[updateLeaveStatus] ✅ Status update notification sent to employee`);
          }
        } catch (err) {
          console.error("[Employee Status Notification] Exception:", err.message);
        }
      })()
    );
  }
  
  // 3. Notify Admin Users - For oversight
  const adminUsers = await User.find({
    org_id: request.org_id,
    role: { $in: ["org_admin", "company_admin", "SUPER_ADMIN"] },
    status: "ACTIVE",
    is_deleted: false,
    _id: { $ne: user.userId }  // Don't notify the approver
  }).select("_id").lean();
  
  for (const admin of adminUsers) {
    notificationPromises.push(
      (async () => {
        try {
          const notifResult = await sendNotification({
            type:          "LEAVE_APPLIED",
            userId:        admin._id,
            org_id:        request.org_id,
            unit_id:       request.unit_id,
            referenceId:   request._id,
            referenceType: "LeaveRequest",
            data: {
              employeeName: employeeName,
              leaveType:    leaveTypeDoc?.name || "Leave",
              startDate:    fmtDate(request.startDate),
              endDate:      fmtDate(request.endDate),
              totalDays:    request.totalDays,
              leaveId:      request._id,
              status:       request.status,
              approvedBy:   user.name || "L1 Approver",
              note:         "L1 approved and forwarded to L2",
            },
            inApp:  true,
            email:  false,
            push:   false
          });
          
          if (notifResult?.inApp?.success) {
            console.log(`[updateLeaveStatus] ✅ Admin notification sent`);
          }
        } catch (err) {
          console.error("[Admin Notification] Exception:", err.message);
        }
      })()
    );
  }
  
  // Wait for all notifications
  await Promise.allSettled(notificationPromises);
  console.log(`[updateLeaveStatus] ✅ All stakeholders notified for L1 approval`);

  if (employeeEmail && ["APPROVED", "REJECTED"].includes(request.status)) {
    const leaveTypeDoc = await LeaveType.findById(request.leaveTypeId).select("name code");
    const approverUser = await User.findById(user.userId).select("name");
    try {
      await sendEmail({
        to:      employeeEmail,
        subject: `Your Leave Request has been ${request.status}`,
        html:    request.status === "APPROVED"
          ? leaveApprovedTemplate({
              name:         employeeName,
              leaveType:    leaveTypeDoc?.name || "Leave",
              startDate:    fmtDate(request.startDate),
              endDate:      fmtDate(request.endDate),
              totalDays:    request.totalDays,
              approverName: approverUser?.name || "Manager",
            })
          : leaveRejectedTemplate({
              name:         employeeName,
              leaveType:    leaveTypeDoc?.name || "Leave",
              startDate:    fmtDate(request.startDate),
              endDate:      fmtDate(request.endDate),
              totalDays:    request.totalDays,
              approverName: approverUser?.name || "Manager",
              reason:       remarks || "",
            }),
      });
    } catch (e) {
      console.error("Leave status notification failed:", e.message);
    }
  }

  // ════════════════════════════════════════════════════════════
  // ENHANCED NOTIFICATION - FINAL DECISION (APPROVED/REJECTED)
  // ════════════════════════════════════════════════════════════
  // Notify: 1) Employee - Decision received
  //        2) L1 Approver - Notified of final result
  //        3) L2 Approver (if exists) - Confirmation
  //        4) Admin - Oversight
  
  if (["APPROVED", "REJECTED"].includes(request.status)) {
    const notificationPromises = [];
    
    // 1. Notify Employee - Primary recipient
    notificationPromises.push(
      (async () => {
        try {
          const notifResult = await sendNotification({
            type:          request.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
            userId:        request.userId,
            org_id:        request.org_id,
            unit_id:       request.unit_id,
            referenceId:   request._id,
            referenceType: "LeaveRequest",
            data: {
              employeeName: employeeName,
              leaveType:    leaveTypeDoc?.name || "Leave",
              startDate:    fmtDate(request.startDate),
              endDate:      fmtDate(request.endDate),
              totalDays:    request.totalDays,
              approverName: user.name || "Manager",
              comment:      remarks || "",
              leaveId:      request._id,
            },
            inApp:  true,
            email:  false,
            push:   true
          });
          
          if (notifResult?.inApp?.success) {
            console.log(`[updateLeaveStatus] ✅ Final decision notification sent to employee`);
          } else {
            console.error(`[updateLeaveStatus] ⚠️ Employee notification failed:`, notifResult);
          }
        } catch (err) {
          console.error("[Employee Final Notification] Exception:", err.message);
        }
      })()
    );
    
    // 2. Notify L1 Approver - Confirmation
    if (request.l1ApproverId && String(request.l1ApproverId) !== String(user.userId)) {
      notificationPromises.push(
        (async () => {
          try {
            const notifResult = await sendNotification({
              type:          request.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
              userId:        request.l1ApproverId,
              org_id:        request.org_id,
              unit_id:       request.unit_id,
              referenceId:   request._id,
              referenceType: "LeaveRequest",
              data: {
                employeeName: employeeName,
                leaveType:    leaveTypeDoc?.name || "Leave",
                startDate:    fmtDate(request.startDate),
                endDate:      fmtDate(request.endDate),
                totalDays:    request.totalDays,
                status:       request.status,
                approverName: user.name || "L2 Approver",
                note:         "Leave request you approved has been finalized",
              },
              inApp:  true,
              email:  false,
              push:   false
            });
            
            if (notifResult?.inApp?.success) {
              console.log(`[updateLeaveStatus] ✅ L1 notified of final decision`);
            }
          } catch (err) {
            console.error("[L1 Confirmation] Exception:", err.message);
          }
        })()
      );
    }
    
    // 3. Notify L2 Approver (if different from action taker) - Confirmation
    if (request.l2ApproverId && String(request.l2ApproverId) !== String(user.userId)) {
      notificationPromises.push(
        (async () => {
          try {
            const notifResult = await sendNotification({
              type:          request.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
              userId:        request.l2ApproverId,
              org_id:        request.org_id,
              unit_id:       request.unit_id,
              referenceId:   request._id,
              referenceType: "LeaveRequest",
              data: {
                employeeName: employeeName,
                leaveType:    leaveTypeDoc?.name || "Leave",
                startDate:    fmtDate(request.startDate),
                endDate:      fmtDate(request.endDate),
                totalDays:    request.totalDays,
                status:       request.status,
                message:      `Leave request has been ${request.status.toLowerCase()}`,
              },
              inApp:  true,
              email:  false,
              push:   false
            });
            
            if (notifResult?.inApp?.success) {
              console.log(`[updateLeaveStatus] ✅ L2 notified of final decision`);
            }
          } catch (err) {
            console.error("[L2 Confirmation] Exception:", err.message);
          }
        })()
      );
    }
    
    // 4. Notify Admin Users - Oversight
    const adminUsers = await User.find({
      org_id: request.org_id,
      role: { $in: ["org_admin", "company_admin", "SUPER_ADMIN"] },
      status: "ACTIVE",
      is_deleted: false,
      _id: { $ne: user.userId }
    }).select("_id").lean();
    
    for (const admin of adminUsers) {
      notificationPromises.push(
        (async () => {
          try {
            const notifResult = await sendNotification({
              type:          request.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
              userId:        admin._id,
              org_id:        request.org_id,
              unit_id:       request.unit_id,
              referenceId:   request._id,
              referenceType: "LeaveRequest",
              data: {
                employeeName: employeeName,
                leaveType:    leaveTypeDoc?.name || "Leave",
                startDate:    fmtDate(request.startDate),
                endDate:      fmtDate(request.endDate),
                totalDays:    request.totalDays,
                status:       request.status,
                note:         "Final decision completed",
              },
              inApp:  true,
              email:  false,
              push:   false
            });
            
            if (notifResult?.inApp?.success) {
              console.log(`[updateLeaveStatus] ✅ Admin notified of final decision`);
            }
          } catch (err) {
            console.error("[Admin Notification] Exception:", err.message);
          }
        })()
      );
    }
    
    // Wait for all notifications
    await Promise.allSettled(notificationPromises);
    console.log(`[updateLeaveStatus] ✅ All stakeholders notified for final decision`);
  }

  return request;
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL LEAVE REQUEST
// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// GET PENDING APPROVALS — for L1/L2 approvers
// GET /leave/pending
// SEQUENTIAL APPROVAL LOGIC:
//   - L1 (Reporting Manager) sees requests where l1ApproverId matches AND l1Status is PENDING/null
//   - L2 (HR Manager) sees requests where l2ApproverId matches AND l1Status is APPROVED AND l2Status is PENDING/null
// ─────────────────────────────────────────────────────────────────────────────
exports.getPendingApprovals = async (query, user) => {
  const { page = 1, limit = 10 } = query;

  // L-05 / DB-02: this queue must show exactly what this user is allowed to
  // approve in updateLeaveStatus. Before, HR / unit admins only saw requests
  // already approved at L1 (UNDER_REVIEW), so a PENDING request shown on the
  // dashboard with Approve/Reject was missing here.
  const isAdminLevel = ["SUPER_ADMIN", "org_admin", "company_admin"].includes(user.role);
  const isHRManager = ["hr_manager", "company_hr_manager", "unit_admin", "hr", "HR", "hr-admin"].includes(user.role);

  let canApproveL1 = false;
  let canApproveL2 = false;
  if (user.roleId) {
    const role = await Role.findById(user.roleId).populate("permissions", "slug").lean();
    const slugs = new Set((role?.permissions || []).map(permission => permission.slug));
    canApproveL1 = slugs.has("leave.approve") || slugs.has("leave.approve.l1");
    canApproveL2 = slugs.has("leave.approve") || slugs.has("leave.approve.l2");
  }
  const seesAllPending = isAdminLevel || isHRManager || canApproveL1;     // can act on PENDING (L1 backup)
  const seesAllUnderReview = isAdminLevel || isHRManager || canApproveL2; // can act on UNDER_REVIEW

  const filter = {
    org_id:     user.orgId,
    company_id: user.companyId,
    isDeleted:  false,
  };
  if (user.unitId && !isAdminLevel) filter.unit_id = user.unitId;

  // Users cannot approve their own leave requests
  if (user.role !== "SUPER_ADMIN") filter.userId = { $ne: user.userId };

  const pendingL1 = { status: "PENDING", l1Status: { $in: ["PENDING", null] } };
  const pendingL2 = { status: "UNDER_REVIEW", l2Status: { $in: ["PENDING", null] } };
  filter.$or = [
    seesAllPending ? pendingL1 : { ...pendingL1, l1ApproverId: user.userId },
    seesAllUnderReview
      ? pendingL2
      // the L1 approver may finish a request that has no L2 approver
      : { $or: [{ ...pendingL2, l2ApproverId: user.userId }, { ...pendingL2, l2ApproverId: null, l1ApproverId: user.userId }] },
  ];

  if (!seesAllPending && !seesAllUnderReview) {
    const managerEmployee = await Employee.findOne({ userId: user.userId, isDeleted: false }).select("_id").lean();
    const isReportingManager = managerEmployee
      ? !!(await Employee.exists({ reportingManagerId: managerEmployee._id, isDeleted: false, status: "ACTIVE" }))
      : false;
    const isAssignedApprover = !!(await LeaveRequest.exists({
      $or: [{ l1ApproverId: user.userId }, { l2ApproverId: user.userId }],
      status: { $in: ["PENDING", "UNDER_REVIEW"] },
      isDeleted: false,
    }));
    if (!isReportingManager && !isAssignedApprover) {
      throw new AppError("You are not authorized to view pending approvals", 403);
    }
  }

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await LeaveRequest.countDocuments(filter);

  const requests = await LeaveRequest.find(filter)
    .populate("employeeId", "name employeeId email profilePhoto")
    .populate("leaveTypeId",  "name code colorCode")
    .populate("l1ApproverId", "name email")
    .populate("l2ApproverId", "name email")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  return {
    requests,
    pagination: {
      total,
      page:  Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  };
};
exports.cancelLeaveRequest = async (id, user, reason = null) => {
  const request = await LeaveRequest.findOne({
    _id:        id,
    userId:     user.userId,
    org_id:     user.orgId,
    company_id: user.companyId,
    isDeleted:  { $ne: true },
  }).populate("leaveTypeId", "name code")
    .populate("l1ApproverId", "name email")
    .populate("l2ApproverId", "name email");

  if (!request) throw new AppError("Leave request not found", 404);

  // PENDING / UNDER_REVIEW → can always be cancelled.
  // APPROVED → can be cancelled only if the leave has not started yet
  //            (start date is after today in org timezone). Once a leave has
  //            started, attendance/payroll may already depend on it, so HR
  //            has to handle that.
  const wasApproved = request.status === "APPROVED";

  if (wasApproved) {
    const moment  = require("moment-timezone");
    const ORG_TZ  = "Asia/Kolkata";
    const today   = moment().tz(ORG_TZ).format("YYYY-MM-DD");
    const startOn = moment(request.startDate).tz(ORG_TZ).format("YYYY-MM-DD");
    if (startOn <= today) {
      throw new AppError(
        "This leave has already started. Please contact HR to cancel or modify it.",
        400
      );
    }
  } else if (!["PENDING", "UNDER_REVIEW"].includes(request.status)) {
    throw new AppError(`Cannot cancel — request is already ${request.status}`, 400);
  }

  const cleanReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";

  request.status             = "CANCELLED";
  request.cancelledAt        = new Date();
  request.cancelledBy        = user.userId;
  request.cancellationReason = cleanReason || "Cancelled by employee";
  await request.save();

  // NOTE: Balance updates removed - balances are calculated dynamically from LeaveRequest records

  // ── Notification to Approver(s) ──
  // Matrix Requirement: Leave cancelled by employee → Approver (🔔) Priority: 🟢 Informational
  const employee = await Employee.findOne({ userId: user.userId, org_id: user.orgId })
    .select("name").lean();
  const leaveTypeName = request.leaveTypeId?.name || "Leave";
  const notifyApprovers = [];

  if (request.l1ApproverId) notifyApprovers.push(request.l1ApproverId);
  if (request.l2ApproverId) notifyApprovers.push(request.l2ApproverId);

  for (const approver of notifyApprovers) {
    if (approver?._id) {
      try {
        const notifResult = await sendNotification({
          type:          "LEAVE_CANCELLED",
          userId:        approver._id,
          org_id:        request.org_id,
          unit_id:       request.unit_id,
          referenceId:   request._id,
          referenceType: "LeaveRequest",
          data: {
            employeeName: employee?.name || user.name || "Employee",
            leaveType:    leaveTypeName,
            startDate:    fmtDate(request.startDate),
            endDate:      fmtDate(request.endDate),
            totalDays:    request.totalDays,
            leaveId:      request._id.toString(),
            wasApproved,
            reason:       request.cancellationReason,
          },
          inApp:  true,
          push:   false   // Informational only
        });
        
        if (notifResult?.inApp?.success) {
          console.log(`[cancelLeaveRequest] ✅ Notification sent to approver ${approver._id}`);
        } else {
          console.error(`[cancelLeaveRequest] ⚠️ Notification failed:`, JSON.stringify(notifResult, null, 2));
        }
      } catch (err) {
        console.error("[cancelLeaveRequest] Notification exception:", err.message);
      }
    }
  }

  console.log(`[cancelLeaveRequest] ✅ Leave cancelled by ${user.userId}, approvers notified`);

  return { message: "Leave request cancelled successfully" };
};

exports.editLeaveRequest = async (id, payload, user) => {
  const { leaveTypeId, startDate, endDate, isHalfDay, session, reason } = payload;

  const request = await LeaveRequest.findOne({
    _id:        id,
    userId:     user.userId,
    org_id:     user.orgId,
    company_id: user.companyId,
    isDeleted:  { $ne: true },
  });
  if (!request) throw new AppError("Leave request not found", 404);

  // Only requests that are still waiting for approval can be edited.
  // An approved leave has to be cancelled (if not started) and re-applied.
  if (!["PENDING", "UNDER_REVIEW"].includes(request.status)) {
    const hint = request.status === "APPROVED"
      ? " Cancel it and apply again with the new details."
      : "";
    throw new AppError(`Cannot edit — request is already ${request.status}.${hint}`, 400);
  }

  const employee = await Employee.findOne({
    _id:       request.employeeId,
    isDeleted: false,
  }).select("name org_id company_id unit_id status gender employmentType");
  if (!employee) throw new AppError("Employee record not found for your account", 404);

  // ── Leave type (new or existing) ─────────────────────────────
  const finalLeaveTypeId = leaveTypeId || request.leaveTypeId;
  const leaveType = await LeaveType.findOne({
    _id: finalLeaveTypeId, company_id: user.companyId, isActive: true, isDeleted: false,
  });
  if (!leaveType) throw new AppError("Leave type not found or inactive", 404);

  if (leaveType.applicableGender && leaveType.applicableGender !== "ALL" &&
      employee.gender && employee.gender !== leaveType.applicableGender) {
    throw new AppError(`${leaveType.name} is only applicable for ${leaveType.applicableGender} employees`, 400);
  }
  if (leaveType.applicableEmploymentTypes?.length && employee.employmentType &&
      !leaveType.applicableEmploymentTypes.includes(employee.employmentType)) {
    throw new AppError(`${leaveType.name} is not applicable for ${employee.employmentType} employees`, 400);
  }

  // ── Dates & duration ─────────────────────────────────────────
  const start = new Date(startDate || request.startDate);
  const end   = new Date(endDate   || request.endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (start < today) throw new AppError("Cannot set leave for past dates", 400);
  if (end < start)   throw new AppError("End date cannot be before start date", 400);

  const halfDay = isHalfDay ?? request.isHalfDay;
  const finalSession = halfDay ? (session || request.session) : null;

  let totalDays;
  if (halfDay) {
    if (!finalSession) throw new AppError("session (FIRST_HALF/SECOND_HALF) required for half day", 400);
    if (start.getTime() !== end.getTime())
      throw new AppError("Start and end date must be same for half day", 400);
    totalDays = 0.5;
  } else {
    totalDays = calcWorkingDays(start, end);
    if (totalDays === 0) throw new AppError("No working days in selected date range", 400);
  }

  const noticeDays = Math.ceil((start - today) / (1000 * 60 * 60 * 24));
  if (leaveType.minNoticeDays > 0 && noticeDays < leaveType.minNoticeDays) {
    throw new AppError(`This leave type requires ${leaveType.minNoticeDays} day(s) advance notice`, 400);
  }
  if (leaveType.maxConsecutiveDays > 0 && !halfDay && totalDays > leaveType.maxConsecutiveDays) {
    throw new AppError(`Maximum ${leaveType.maxConsecutiveDays} consecutive days allowed for ${leaveType.name}`, 400);
  }

  // ── Overlap (ignoring this request) ──────────────────────────
  const overlap = await LeaveRequest.findOne({
    _id:        { $ne: request._id },
    employeeId: request.employeeId,
    status:     { $in: ["PENDING", "UNDER_REVIEW", "APPROVED"] },
    startDate:  { $lte: end },
    endDate:    { $gte: start },
    isDeleted:  { $ne: true },
  });
  if (overlap) throw new AppError("Overlapping leave request already exists for these dates", 409);

  // ── Balance check (same rule as applyLeave) ──────────────────
  const { getActiveLeavePolicy, calculateLeaveUsage } = require("./leave.service");
  const activePolicy = await getActiveLeavePolicy(employee.org_id, employee.company_id, employee.unit_id);
  if (!activePolicy) {
    throw new AppError("No active leave policy found for your unit. Please contact HR.", 400);
  }
  const policyLeaveType = activePolicy.leaveTypes.find(
    (plt) => plt.isActive &&
      (plt.leaveTypeId?.toString() === finalLeaveTypeId.toString() || plt.code === leaveType.code)
  );
  if (!policyLeaveType) {
    throw new AppError(
      `Leave type "${leaveType.name}" is not configured in the active leave policy. Please contact HR.`,
      400
    );
  }

  const allocated = policyLeaveType.credit?.totalPerYear || 0;
  const usage = await calculateLeaveUsage(employee._id, finalLeaveTypeId, today.getFullYear());
  // This request's own days are already counted as "pending" for its current
  // leave type — don't count them twice when the type stays the same.
  const sameType = String(request.leaveTypeId) === String(finalLeaveTypeId);
  const ownPending = sameType && ["PENDING", "UNDER_REVIEW"].includes(request.status)
    ? (request.totalDays || 0)
    : 0;
  const remaining = Math.max(0, allocated - usage.used - (usage.pending - ownPending));
  if (remaining < totalDays) {
    throw new AppError(
      `Insufficient leave balance. Available: ${remaining} day(s), Requested: ${totalDays} day(s)`,
      400
    );
  }

  // ── Apply changes ────────────────────────────────────────────
  request.leaveTypeId = finalLeaveTypeId;
  request.startDate   = start;
  request.endDate     = end;
  request.isHalfDay   = halfDay;
  request.session     = finalSession;
  if (typeof reason === "string" && reason.trim()) request.reason = reason.trim();
  request.totalDays   = totalDays;
  request.editedAt    = new Date();
  request.editedBy    = user.userId;

  // Details changed → approval starts again from L1
  request.status     = "PENDING";
  request.l1Status   = request.l1ApproverId ? "PENDING" : null;
  request.l1ActionAt = null;
  request.l1Comment  = null;
  request.l2Status   = request.l2ApproverId ? "PENDING" : null;
  request.l2ActionAt = null;
  request.l2Comment  = null;

  await request.save();

  // ── Notify the approver who has to look at it again ──────────
  const notifyId = request.l1ApproverId || request.l2ApproverId;
  if (notifyId) {
    try {
      await sendNotification({
        type:          "LEAVE_APPLIED",
        userId:        notifyId,
        org_id:        request.org_id,
        unit_id:       request.unit_id,
        referenceId:   request._id,
        referenceType: "LeaveRequest",
        data: {
          employeeName: employee.name || user.name || "Employee",
          leaveType:    leaveType.code || leaveType.name || "Leave",
          startDate:    fmtDate(start),
          endDate:      fmtDate(end),
          totalDays,
          leaveId:      request._id,
          edited:       true,
          priority:     "HIGH",
        },
        inApp: true,
        email: false,
        push:  true,
      });
    } catch (err) {
      console.error("[editLeaveRequest] Notification exception:", err.message);
    }
  }

  return request;
};