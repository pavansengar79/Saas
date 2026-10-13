// modules/dashboard/dashboard.service.js
// FIXED — correct field names per model + Customer model for super admin

"use strict";

const mongoose = require("mongoose");
const AppError = require("../../utils/appError");
const moment = require("moment-timezone");

const Employee     = require("../employee/models/employee.model");
const Attendance   = require("../attendance/models/attendance.model");
const Department   = require("../department/department.model");
const Designation  = require("../designation/designation.model");
const LeaveRequest = require("../leave/models/leaveRequest.models");
const User         = require("../auth/models/user.model");
const Company      = require("../company/models/company.model");
const LOB          = require("../lob/models/lob.model");
const Unit         = require("../unit/models/unit.model");
const Holiday      = require("../holiday/models/holiday.models");
const Customer     = require("../customer/models/customer.model");
const Organization = require("../organisation/models/organization.model");
const Subscription = require("../subscription/models/subscription.Models");
const Plan         = require("../plan/models/plan.model");
const AuditLog     = require("../superAdmin/models/auditLog.models");
const Role = require("../role/role.model");
const CompanyConfig = require("../companyConfig/models/companyConfig.model");

// CRITICAL FIX: Import timezone utility for consistent date handling
const { getTodayDateInOrgTimezone } = require("../../utils/timezone");


const toObjId = (id) => new mongoose.Types.ObjectId(id);

// Create date range based on ORGANIZATION TIMEZONE (not server timezone)
// CRITICAL FIX: Use same date generation method as attendance service
// Attendance records use getTodayDateInOrgTimezone() which calls moment().tz().startOf('day').toDate()
const todayRange = (timezone = 'Asia/Kolkata') => {
  const now = moment.tz(timezone);
  console.log('[todayRange] Current time in', timezone, ':', now.format('YYYY-MM-DD HH:mm:ss Z'));
  
  // Get the date string in org timezone (e.g., "2026-08-24")
  const todayDateString = now.format('YYYY-MM-DD');
  console.log('[todayRange] Today date string RETURNED:', todayDateString);
  
  // CRITICAL: Use moment to create midnight date, matching attendance storage
  // This ensures exact match with how attendance records are stored
  const start = now.clone().startOf('day').toDate();
  // End of day (23:59:59.999 in org timezone)
  const end = now.clone().endOf('day').toDate();
  
  console.log('[todayRange] Start:', start.toISOString());
  console.log('[todayRange] End:', end.toISOString());
  
  return { start, end, dateString: todayDateString };
};

const monthRange = (monthStr) => {
  const [year, mon] = monthStr.split("-").map(Number);
  const start = new Date(Date.UTC(year, mon - 1, 1));
  const end   = new Date(Date.UTC(year, mon, 1) - 1);
  return { start, end };
};

const currentMonthStr = (timezone = 'Asia/Kolkata') => {
  const now = moment.tz(timezone);
  return `${now.year()}-${String(now.month() + 1).padStart(2, "0")}`;
};

const currentYear = (timezone = 'Asia/Kolkata') => moment.tz(timezone).year();

// ─────────────────────────────────────────────────────────────────────────────
// 1. ORG ADMIN DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

exports.getOrgDashboard = async (user) => {
  const { orgId } = user;
  const thisMonthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  // FIX (Bug: Dashboard Total Users Count Mismatch) — "Total Users" must
  // count the same set of users as the Admin Users list (user.service.js
  // getUsers), which excludes the "employee" role. Without this, the
  // dashboard counts employee-role login accounts that never show up in
  // the Admin Users screen, causing a count mismatch.
  const employeeRole = await Role.findOne({ slug: "employee" }).select("_id").lean();
  const adminUserFilter = { org_id: orgId, is_deleted: false };
  if (employeeRole) adminUserFilter.roleId = { $ne: employeeRole._id };

  const [
    companies, lobCount, userCount, employeeCount,
    recentCompanies, subscription, roleCount,
    pendingLeaves, pendingRegularizations, recentActivity
  ] = await Promise.all([

    Company.aggregate([
      { $match: { org_id: toObjId(orgId), is_deleted: false } },
      { $group: {
        _id: null,
        total:        { $sum: 1 },
        active:       { $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] } },
        inactive:     { $sum: { $cond: [{ $eq: ["$status", "Inactive"] }, 1, 0] } },
        newThisMonth: { $sum: { $cond: [{ $gte: ["$createdAt", thisMonthStart] }, 1, 0] } },
      }},
    ]),

    LOB.countDocuments({ org_id: orgId, is_deleted: false }),
    User.countDocuments(adminUserFilter),
    Employee.countDocuments({ org_id: orgId, isDeleted: false }),

    Company.find({ org_id: orgId, is_deleted: false })
      .sort({ createdAt: -1 }).limit(5)
      .select("company_name company_email status createdAt company_code").lean(),

    // Subscription info
    Subscription.findOne({ org_id: orgId, is_active: true }).lean(),

    // Roles count (system + custom)
    Role.countDocuments({
      $or: [{ org_id: orgId }, { org_id: null, isSystem: true }],
      isDeleted: false,
      status: "ACTIVE",
    }),

    // Pending leave requests
    LeaveRequest.countDocuments({
      org_id: orgId,
      status: { $in: ["PENDING", "UNDER_REVIEW"] },
    }),

    // Pending regularizations
    Attendance.countDocuments({
      org_id: orgId,
      "regularization.status": { $in: ["PENDING", "UNDER_REVIEW"] },
    }),

    // Recent activity — last 5 users joined
    User.find({ org_id: orgId, is_deleted: false })
      .sort({ createdAt: -1 }).limit(5)
      .select("name email createdAt").lean(),
  ]);

  const compStats = companies[0] || { total: 0, active: 0, inactive: 0, newThisMonth: 0 };

  // Subscription details
  const daysLeft = subscription?.ends_at
    ? Math.max(0, Math.ceil((new Date(subscription.ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
    : null;

  return {
    generatedAt: new Date(),

    // Plan & Subscription
    subscription: subscription ? {
      plan_name:       subscription.plan_snapshot?.name || null,
      status:          subscription.status,
      is_trial:        subscription.status === "Trial",
      days_left:       daysLeft,
      ends_at:         subscription.ends_at,
      features:        subscription.plan_snapshot?.features || [],
      structure_level: subscription.plan_snapshot?.structure_level || null,
    } : null,

    // Org Stats
    companies: {
      total:        compStats.total,
      active:       compStats.active,
      inactive:     compStats.inactive,
      newThisMonth: compStats.newThisMonth,
    },
    lobs:      { total: lobCount },
    users:     { total: userCount },
    employees: { total: employeeCount },
    roles:     { total: roleCount },

    // Pending Actions
    pendingActions: {
      leaves:          pendingLeaves,
      regularizations: pendingRegularizations,
      total:           pendingLeaves + pendingRegularizations,
    },

    // Recent Activity
    recentActivity: recentActivity.map((u) => ({
      type:      "USER_JOINED",
      name:      u.name,
      email:     u.email,
      timestamp: u.createdAt,
    })),

    recentCompanies: recentCompanies.map((c) => ({
      id:        c._id,
      name:      c.company_name,
      email:     c.company_email,
      code:      c.company_code,
      status:    c.status,
      createdAt: c.createdAt,
    })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. COMPANY ADMIN DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

exports.getCompanyDashboard = async (user, query = {}) => {
  const { orgId } = user;

  // ── Resolve target company based on role ──────────────────────
  let companyId;

  if (user.role === "org_admin") {
    companyId = query.companyId || user.companyId;
    const company = await Company.findOne({ _id: companyId, org_id: orgId, is_deleted: false });
    if (!company) throw new AppError("Company not found", 404);
  } else if (user.role === "company_admin") {
    companyId = user.companyId;
  } else {
    throw new AppError("Access denied", 403);
  }

  const today          = new Date();
  const thisMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const employeeRole = await Role.findOne({ slug: "employee" }).select("_id").lean();
  const adminUserFilter = {
    org_id: orgId,
    company_id: companyId,
    is_deleted: false,
    ...(employeeRole && { roleId: { $ne: employeeRole._id } }),
  };

  const [unitStats, lobCount, userCount, deptCount, desigCount, employeeCount, recentUsers, upcomingHolidays, recentUnits, roleCount, recentActivity] = await Promise.all([

    Unit.aggregate([
      { $match: { org_id: toObjId(orgId), company_id: toObjId(companyId), is_deleted: false } },
      { $group: {
        _id:          null,
        total:        { $sum: 1 },
        newThisMonth: { $sum: { $cond: [{ $gte: ["$createdAt", thisMonthStart] }, 1, 0] } },
      }},
    ]),

    LOB.countDocuments({ org_id: orgId, company_id: companyId, is_deleted: false }),
    User.countDocuments(adminUserFilter),
    Department.countDocuments({ org_id: orgId, company_id: companyId, isDeleted: false }),
    Designation.countDocuments({ org_id: orgId, company_id: companyId, isDeleted: false }),
    Employee.countDocuments({ org_id: orgId, company_id: companyId, isDeleted: false }),

    User.find(adminUserFilter)
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("roleId", "name slug")
      .select("name email status createdAt roleId")
      .lean(),

    Holiday.find({
      org_id:     orgId,
      company_id: companyId,
      date:       { $gte: today },
      isDeleted:  false,
    })
      .sort({ date: 1 })
      .limit(5)
      .select("name date type isOptional")
      .lean(),

    Unit.find({ org_id: orgId, company_id: companyId, is_deleted: false })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("lob_id", "name")
      .select("name location status createdAt lob_id")
      .lean(),

    Role.countDocuments({
      level: "company",
      $or: [
        { org_id: orgId, company_id: companyId, unit_id: null },
        { org_id: null, isSystem: true }
      ],
      isDeleted: false,
      status: "ACTIVE",
    }),

    User.find(adminUserFilter)
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name email createdAt")
      .lean(),
  ]);

  const unitS = unitStats[0] || { total: 0, newThisMonth: 0 };

  return {
    generatedAt:  new Date(),
    companyId,
    units:        { total: unitS.total, newThisMonth: unitS.newThisMonth },
    lobs:         { total: lobCount },
    users:        { total: userCount },
    departments:  { total: deptCount },
    designations: { total: desigCount },
    employees:    { total: employeeCount },
    roles:        { total: roleCount },
    recentUsers: recentUsers.map((u) => ({
      id:       u._id,
      name:     u.name,
      email:    u.email,
      role:     u.roleId?.name || null,
      status:   u.status,
      joinedAt: u.createdAt,
    })),
    upcomingHolidays: upcomingHolidays.map((h) => ({
      id:         h._id,
      name:       h.name,
      date:       h.date,
      type:       h.type,
      isOptional: h.isOptional,
    })),
    recentUnits: recentUnits.map((u) => ({
      id:       u._id,
      name:     u.name,
      location: u.location,
      lob:      u.lob_id?.name || null,
      status:   u.status,
    })),
    recentActivity: recentActivity.map((u) => ({
      type:      "USER_JOINED",
      name:      u.name,
      email:     u.email,
      timestamp: u.createdAt,
    })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. UNIT ADMIN / HR DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

exports.getUnitDashboard = async (user, query = {}) => {
  const { orgId } = user;

  console.log('[getUnitDashboard] CALLED - user.role:', user.role, 'user.unitId:', user.unitId, 'query:', query);

  // ── Resolve target unit based on role ───────────────────────────
  let unitId, companyId;

  if (["org_admin", "company_admin", "unit_admin", "hr_manager"].includes(user.role)) {
    // unit_admin / hr_manager can only ever see their OWN unit — the query
    // param is ignored for them so they can't browse another unit's dashboard.
    // Only org_admin / company_admin (who already have broader company/org
    // scope) may pick an arbitrary unitId, and it's still validated below
    // against their own org/company.
    unitId = ["unit_admin", "hr_manager"].includes(user.role)
      ? user.unitId
      : (query.unitId || user.unitId);
    console.log('[getUnitDashboard] Role allowed, resolved unitId:', unitId);

    const unitFilter = {
      _id:        unitId,
      org_id:     orgId,
      is_deleted: false,
      ...(user.role !== "org_admin" && { company_id: user.companyId }),
    };

    console.log('[getUnitDashboard] unitFilter:', JSON.stringify(unitFilter));

    const unit = await Unit.findOne(unitFilter);
    console.log('[getUnitDashboard] unit found:', unit ? unit._id : 'NULL');

    if (!unit) throw new AppError("Unit not found", 404);

    companyId = unit.company_id;
  } else {
    console.log('[getUnitDashboard] Role NOT in allowed list, throwing 403');
    throw new AppError("Access denied", 403);
  }

  // Fetch organization timezone from CompanyConfig
  const companyConfig = await CompanyConfig.findOne({ org_id: orgId, company_id: companyId })
    .select('timezone')
    .lean();
  const timezone = companyConfig?.timezone || 'Asia/Kolkata';
  
  const month = query.month || currentMonthStr(timezone);
  const { start: monthStart, end: monthEnd } = monthRange(month);
  
  const { start: todayStart, end: todayEnd, dateString: todayDateString } = todayRange(timezone);

  console.log('[getUnitDashboard] AFTER todayRange call:', {
    timezone,
    todayDateStringReturned: todayDateString,
    todayDateStringType: typeof todayDateString,
    todayStartISO: todayStart.toISOString(),
    todayEndISO: todayEnd.toISOString(),
    currentTime: new Date().toISOString()
  });

  // ── CRITICAL FIX: Find employee role to exclude from user stats ──
  // Users and Employees are separate entities:
  // - Users: Administrative accounts (org_admin, company_admin, unit_admin, hr_manager, manager)
  // - Employees: Workforce managed separately via Employee collection
  const employeeRole = await Role.findOne({ slug: "employee" }).select("_id").lean();

  const [userStats, deptCount, desigCount, employeeCount, todayAtt, pendingLeaves, recentUsers, upcomingHols, roleCount, roleList, recentActivityUsers, recentLeaves, monthAtt] = await Promise.all([

    User.aggregate([
      { $match: { 
        org_id: toObjId(orgId), 
        company_id: toObjId(companyId), 
        unit_id: toObjId(unitId), 
        is_deleted: false,
        // ── EXCLUDE EMPLOYEES: Count only administrative users ──
        ...(employeeRole && { roleId: { $ne: employeeRole._id } })
      }},
      { $group: {
        _id:      null,
        total:    { $sum: 1 },
        active:   { $sum: { $cond: [{ $eq: ["$status", "ACTIVE"] }, 1, 0] } },
        inactive: { $sum: { $cond: [{ $eq: ["$status", "INACTIVE"] }, 1, 0] } },
        blocked:  { $sum: { $cond: [{ $eq: ["$status", "BLOCKED"] }, 1, 0] } },
      }},
    ]),

    Department.countDocuments({ org_id: orgId, company_id: companyId, unit_id: unitId, isDeleted: false }),
    Designation.countDocuments({ org_id: orgId, company_id: companyId, unit_id: unitId, isDeleted: false }),

    Employee.countDocuments({ org_id: orgId, company_id: companyId, unit_id: unitId, isDeleted: false }),

    Attendance.aggregate([
      { $match: {
        org_id:     toObjId(orgId),
        company_id: toObjId(companyId),
        unit_id:    toObjId(unitId),
        date:       { $gte: todayStart, $lte: todayEnd },
      }},
      { $group: {
        _id: "$status",
        count: { $sum: 1 },
        wfh: { $sum: { $cond: [{ $eq: ["$isWFH", true] }, 1, 0] } },
      } },
    ]),

    LeaveRequest.find({
      org_id:     orgId,
      company_id: companyId,
      unit_id:    unitId,
      status:     "PENDING",
      isDeleted:  false,
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("employeeId", "name employeeId")
      .populate("leaveTypeId", "name code")
      .select("startDate endDate totalDays status createdAt")
      .lean(),

    User.find({ org_id: orgId, company_id: companyId, unit_id: unitId, is_deleted: false })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("roleId", "name slug")
      .select("name email status createdAt roleId")
      .lean(),

    Holiday.find({
      org_id:     orgId,
      company_id: companyId,
      // For unit-level users (hr_manager, unit_admin), show holidays for their unit OR company-wide holidays
      ...(unitId && { $or: [{ unit_id: unitId }, { unit_id: null }] }),
      date:       { $gte: new Date() },
      isDeleted:  false,
    })
      .sort({ date: 1 })
      .limit(3)
      .select("name date type")
      .lean(),

    Role.countDocuments({
      level: "unit",
      $or: [
        { org_id: orgId, company_id: companyId, unit_id: unitId },
        { org_id: null, isSystem: true }
      ],
      isDeleted: false,
      status: "ACTIVE",
    }),

    Role.find({
      level: "unit",
      $or: [
        { org_id: orgId, company_id: companyId, unit_id: unitId },
        { org_id: null, isSystem: true }
      ],
      isDeleted: false,
      status: "ACTIVE",
    })
      .sort({ name: 1 })
      .limit(10)
      .select("name slug description")
      .lean(),

    User.find({ org_id: orgId, unit_id: unitId, is_deleted: false })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("name email createdAt")
      .lean(),

    // Fetch recent leave approvals/rejections for activity feed
    LeaveRequest.find({
      org_id: orgId,
      unit_id: unitId,
      status: { $in: ["APPROVED", "REJECTED"] },
      isDeleted: false,
    })
      .sort({ updatedAt: -1 })
      .limit(10)
      .populate("employeeId", "name employeeId")
      .select("status updatedAt startDate endDate totalDays employeeId approvalHistory")
      .lean(),

    Attendance.aggregate([
      { $match: {
        org_id:     toObjId(orgId),
        company_id: toObjId(companyId),
        unit_id:    toObjId(unitId),
        date:       { $gte: monthStart, $lte: monthEnd },
      }},
      { $group: {
        _id:                null,
        present:            { $sum: { $cond: [{ $in: ["$status", ["PRESENT", "WFH", "LATE"]] }, 1, 0] } },
        absent:             { $sum: { $cond: [{ $eq: ["$status", "ABSENT"] }, 1, 0] } },
        late:               { $sum: { $cond: [{ $eq: ["$status", "LATE"] }, 1, 0] } },
        onLeave:            { $sum: { $cond: [{ $eq: ["$status", "ON_LEAVE"] }, 1, 0] } },
        totalWorkingHours:  { $sum: { $ifNull: ["$workingHours", 0] } },
        totalOvertimeHours: { $sum: { $ifNull: ["$overtimeHours", 0] } },
      }},
    ]),
  ]);

  const todayMap = { PRESENT: 0, ABSENT: 0, LATE: 0, HALF_DAY: 0, ON_LEAVE: 0, WFH: 0 };
  
  console.log('[getUnitDashboard] Today attendance raw result:', {
    todayAttLength: todayAtt.length,
    todayAttData: todayAtt,
    queryDateRange: {
      start: todayStart,
      end: todayEnd,
      startISO: todayStart.toISOString(),
      endISO: todayEnd.toISOString()
    }
  });
  
  // Debug: Show first few attendance records to see what dates they have
  const sampleAttendance = await Attendance.find({
    org_id: orgId,
    company_id: companyId,
    unit_id: unitId
  }).sort({ date: -1 }).limit(5).select('date status employeeId').lean();
  
  console.log('[getUnitDashboard] Sample recent attendance records:', {
    count: sampleAttendance.length,
    records: sampleAttendance.map(a => ({
      employeeId: a.employeeId?.toString(),
      date: a.date,
      dateISO: a.date?.toISOString(),
      status: a.status
    }))
  });
  
  todayAtt.forEach((r) => { if (todayMap[r._id] !== undefined) todayMap[r._id] = r.count; });
  const wfhCount = todayAtt.reduce((count, record) => count + (record._id === "WFH" ? record.count : record.wfh), 0);
  const totalPresent = todayMap.PRESENT + todayMap.LATE + todayMap.WFH;
  
  // Calculate absent: total employees - those who are present/late/wfh/onLeave
  const calculatedAbsent = Math.max(0, employeeCount - totalPresent - todayMap.ON_LEAVE);
  
  console.log('[getUnitDashboard] Today calculation:', {
    employeeCount,
    todayAttRaw: todayAtt,
    todayMap,
    totalPresent,
    calculatedAbsent,
    pendingLeavesCount: pendingLeaves.length
  });
  
  console.log('[getUnitDashboard] Recent Activity DEBUG:', {
    orgId,
    companyId,
    unitId,
    recentUsersCount: recentActivityUsers?.length || 0,
    recentUsersFirst: recentActivityUsers?.[0] || null,
    recentLeavesCount: recentLeaves?.length || 0,
    recentLeavesFirst: recentLeaves?.[0] || null,
    roleCount
  });

  // Build activity feed combining user joins and leave actions
  const activityFeed = [];
  
  // Add user joined activities
  (recentActivityUsers || []).forEach(user => {
    activityFeed.push({
      type: 'USER_JOINED',
      description: `${user.name} joined the unit`,
      name: user.name,
      timestamp: user.createdAt,
    });
  });
  
  // Add leave approved/rejected activities
  (recentLeaves || []).forEach(leave => {
    const employeeName = leave.employeeId?.name || 'Unknown';
    const lastApproval = (leave.approvalHistory || []).slice(-1)[0];
    const approverName = lastApproval?.approverName || 'System';
    const leaveDates = `${new Date(leave.startDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} - ${new Date(leave.endDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`;
    
    if (leave.status === 'APPROVED') {
      activityFeed.push({
        type: 'LEAVE_APPROVED',
        description: `${approverName} approved leave for ${employeeName} (${leaveDates})`,
        name: employeeName,
        timestamp: lastApproval?.actionAt || leave.updatedAt,
      });
    } else if (leave.status === 'REJECTED') {
      activityFeed.push({
        type: 'LEAVE_REJECTED',
        description: `${approverName} rejected leave for ${employeeName} (${leaveDates})`,
        name: employeeName,
        timestamp: lastApproval?.actionAt || leave.updatedAt,
      });
    }
  });
  
  // Sort by timestamp (most recent first) and take top 5
  const recentActivity = activityFeed
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 5);

  console.log('[getUnitDashboard] Recent Activity FINAL:', {
    activityFeedLength: activityFeed.length,
    recentActivityLength: recentActivity.length,
    recentActivityData: recentActivity.map(a => ({
      type: a.type,
      description: a.description,
      timestamp: a.timestamp,
      timestampISO: a.timestamp ? new Date(a.timestamp).toISOString() : null
    }))
  });

  const uStats = userStats[0] || { total: 0, active: 0, inactive: 0, blocked: 0 };
  const mAtt   = monthAtt[0]  || { present: 0, absent: 0, late: 0, onLeave: 0, totalWorkingHours: 0, totalOvertimeHours: 0 };

  return {
    generatedAt: new Date(),
    unitId,
    companyId,
    roles: { total: roleCount, list: roleList },
    recentActivity,
    month,
    users:        { total: uStats.total, active: uStats.active, inactive: uStats.inactive, blocked: uStats.blocked },
    employees:    { total: employeeCount },
    departments:  { total: deptCount },
    designations: { total: desigCount },
    todayAttendance: {
      date:           todayDateString,
      present:        totalPresent,
      absent:         calculatedAbsent,  // Calculated based on total employees
      late:           todayMap.LATE,
      onLeave:        todayMap.ON_LEAVE,
      wfh:            wfhCount,
      attendanceRate: employeeCount > 0 ? Math.round((totalPresent / employeeCount) * 100) : 0,
    },
    monthlyAttendance: {
      present:            mAtt.present,
      absent:             mAtt.absent,
      late:               mAtt.late,
      onLeave:            mAtt.onLeave,
      totalWorkingHours:  parseFloat((mAtt.totalWorkingHours  || 0).toFixed(2)),
      totalOvertimeHours: parseFloat((mAtt.totalOvertimeHours || 0).toFixed(2)),
    },
    pendingLeaveCount: pendingLeaves.length,
    pendingLeaves: pendingLeaves.map((l) => ({
      id:        l._id,
      employee:  { id: l.employeeId?._id, name: l.employeeId?.name, employeeId: l.employeeId?.employeeId },
      leaveType: { name: l.leaveTypeId?.name, code: l.leaveTypeId?.code },
      startDate: l.startDate,
      endDate:   l.endDate,
      totalDays: l.totalDays,
      appliedOn: l.createdAt,
    })),
    recentUsers: recentUsers.map((u) => ({
      id:     u._id,
      name:   u.name,
      email:  u.email,
      role:   u.roleId?.name || null,
      status: u.status,
    })),
    upcomingHolidays: upcomingHols.map((h) => ({
      id:   h._id,
      name: h.name,
      date: h.date,
      type: h.type,
    })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. EMPLOYEE SELF-SERVICE DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

exports.getEmployeeDashboard = async (user, query = {}) => {
  const { orgId, companyId, unitId, userId } = user;
  
  // Fetch organization timezone
  const companyConfig = await CompanyConfig.findOne({ org_id: orgId, company_id: companyId })
    .select('timezone')
    .lean();
  const timezone = companyConfig?.timezone || 'Asia/Kolkata';
  
  const month = query.month || currentMonthStr(timezone);
  const [yr, mon] = month.split("-").map(Number);
  const year = yr; // Use year from month parameter, not current year
  const { start: monthStart, end: monthEnd } = monthRange(month);
  const { start: todayStart, end: todayEnd, dateString: todayDateString } = todayRange(timezone);

  const employee = await Employee.findOne({
    userId,
    org_id:     orgId,
    company_id: companyId,
    isDeleted:  false,
  })
    .populate("departmentId",  "name")
    .populate("designationId", "name")
    .lean();

  if (!employee) throw new AppError("Employee record not found", 404);

  const empId = employee._id;
  const daysInMonth = new Date(yr, mon, 0).getDate();

  // CRITICAL FIX: Use dynamic leave balance calculation from active policy
  // This replaces the old LeaveBalance collection approach
  const leaveService = require("../leave/leave.service");
  const leaveBalancesData = await leaveService.calculateDynamicLeaveBalances(empId, year);
  const leaveBalances = leaveBalancesData.balances || [];

  // CRITICAL FIX: Use timezone-aware date generation consistent with attendance service
  const todayMidnightTimestamp = getTodayDateInOrgTimezone(timezone);
  
  const [todayRecord, monthAtt, recentLeaves, upcomingHols] = await Promise.all([

    // CRITICAL FIX: Query by exact date match (org timezone midnight)
    // Attendance records are stored with moment().tz(timezone).startOf('day').toDate()
    Attendance.findOne({
      org_id:     orgId,
      company_id: companyId,
      unit_id:    unitId,
      employeeId: empId,
      date:       todayMidnightTimestamp, // Exact match using same method as attendance storage
    }).select("checkIn checkOut status isLate lateMinutes workingHours isWFH").lean(),

    Attendance.aggregate([
      { $match: {
        org_id:     toObjId(orgId),
        company_id: toObjId(companyId),
        employeeId: empId,
        date:       { $gte: monthStart, $lte: monthEnd },
      }},
      { $group: {
        _id:                null,
        present:            { $sum: { $cond: [{ $in: ["$status", ["PRESENT", "WFH", "LATE"]] }, 1, 0] } },
        absent:             { $sum: { $cond: [{ $eq: ["$status", "ABSENT"] }, 1, 0] } },
        late:               { $sum: { $cond: [{ $eq: ["$status", "LATE"] }, 1, 0] } },
        halfDay:            { $sum: { $cond: [{ $eq: ["$status", "HALF_DAY"] }, 1, 0] } },
        onLeave:            { $sum: { $cond: [{ $eq: ["$status", "ON_LEAVE"] }, 1, 0] } },
        wfh:                { $sum: { $cond: [{ $eq: ["$status", "WFH"] }, 1, 0] } },
        totalWorkingHours:  { $sum: { $ifNull: ["$workingHours", 0] } },
        totalOvertimeHours: { $sum: { $ifNull: ["$overtimeHours", 0] } },
        totalLateMinutes:   { $sum: { $ifNull: ["$lateMinutes", 0] } },
      }},
    ]),

    LeaveRequest.find({
      org_id:     orgId,
      company_id: companyId,
      employeeId: empId,
      isDeleted:  false,
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("leaveTypeId", "name code color")
      .select("startDate endDate totalDays status remarks createdAt")
      .lean(),

    Holiday.find({
      org_id:     orgId,
      company_id: companyId,
      // Show holidays for employee's unit OR company-wide holidays
      ...(unitId && { $or: [{ unit_id: unitId }, { unit_id: null }] }),
      date:       { $gte: new Date() },
      isDeleted:  false,
    })
      .sort({ date: 1 })
      .limit(4)
      .select("name date type")
      .lean(),
  ]);

  const att = monthAtt[0] || {
    present: 0, absent: 0, late: 0, halfDay: 0, onLeave: 0, wfh: 0,
    totalWorkingHours: 0, totalOvertimeHours: 0, totalLateMinutes: 0,
  };

  return {
    generatedAt: new Date(),
    month,
    employee: {
      id:             employee._id,
      employeeId:     employee.employeeId,
      name:           employee.name,
      email:          employee.email,
      department:     employee.departmentId?.name  || null,
      designation:    employee.designationId?.name || null,
      joiningDate:    employee.joiningDate,
      employmentType: employee.employmentType,
      status:         employee.status,
    },
    today: {
      date:          todayDateString,
      hasPunchedIn:  !!todayRecord?.checkIn,
      hasPunchedOut: !!todayRecord?.checkOut,
      isLive:        !!(todayRecord?.checkIn && !todayRecord?.checkOut),
      checkIn:       todayRecord?.checkIn   || null,
      checkOut:      todayRecord?.checkOut  || null,
      status:        todayRecord?.status    || null,
      isLate:        todayRecord?.isLate    || false,
      lateMinutes:   todayRecord?.lateMinutes || 0,
      workingHours:  parseFloat((todayRecord?.workingHours || 0).toFixed(2)),
      isWFH:         todayRecord?.isWFH     || false,
    },
    attendance: {
      month,
      daysInMonth,
      present:            att.present,
      absent:             att.absent,
      late:               att.late,
      halfDay:            att.halfDay,
      onLeave:            att.onLeave,
      wfh:                att.wfh,
      totalWorkingHours:  parseFloat((att.totalWorkingHours  || 0).toFixed(2)),
      totalOvertimeHours: parseFloat((att.totalOvertimeHours || 0).toFixed(2)),
      totalLateMinutes:   att.totalLateMinutes || 0,
    },
    leaveBalances: leaveBalances.map((lb) => ({
      leaveType:      lb.leaveTypeId?.name,
      code:           lb.leaveTypeId?.code,
      color:          lb.leaveTypeId?.colorCode,
      totalAllocated: lb.allocated || 0,
      used:           lb.used     || 0,
      pending:        lb.pending  || 0,
      remaining:      lb.remaining || 0,
    })),
    recentLeaves: recentLeaves.map((l) => ({
      id:        l._id,
      leaveType: { name: l.leaveTypeId?.name, code: l.leaveTypeId?.code, color: l.leaveTypeId?.color },
      startDate: l.startDate,
      endDate:   l.endDate,
      totalDays: l.totalDays,
      status:    l.status,
      remarks:   l.remarks,
      appliedOn: l.createdAt,
    })),
    upcomingHolidays: upcomingHols.map((h) => ({
      id:   h._id,
      name: h.name,
      date: h.date,
      type: h.type,
    })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. MANAGER DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
// Manager is an employee with team responsibilities (L1 approver)
// Returns: team stats + pending approvals + manager's own employee dashboard

exports.getManagerDashboard = async (user, query = {}) => {
  const { orgId, companyId, unitId } = user;
  
  // Fetch organization timezone
  const companyConfig = await CompanyConfig.findOne({ org_id: orgId, company_id: companyId })
    .select('timezone')
    .lean();
  const timezone = companyConfig?.timezone || 'Asia/Kolkata';
  
  const month = query.month || currentMonthStr(timezone);
  const { start: monthStart, end: monthEnd } = monthRange(month);
  const { start: todayStart, end: todayEnd, dateString: todayDateString } = todayRange(timezone);

  // 1. Get manager's employee record
  const managerEmployee = await Employee.findOne({
    userId: user.userId,
    org_id: orgId,
    isDeleted: false,
  }).select("_id name email employeeId departmentId designationId reportingManagerId").lean();

  if (!managerEmployee) {
    throw new AppError("Employee record not found", 404);
  }

  // 2. Get team members (employees reporting to this manager)
  const teamMembers = await Employee.find({
    reportingManagerId: managerEmployee._id,
    org_id: orgId,
    company_id: companyId,
    unit_id: unitId,
    isDeleted: false,
    status: "ACTIVE",
  }).select("_id name employeeId status").lean();

  const teamIds = teamMembers.map(e => e._id);

  // 3. Team attendance for today
  const teamAttendanceToday = await Attendance.find({
    org_id: orgId,
    company_id: companyId,
    unit_id: unitId,
    employeeId: { $in: teamIds },
    date: { $gte: todayStart, $lte: todayEnd },
  }).select("employeeId status checkIn checkOut").lean();

  // 4. Pending leave requests from team
  const pendingLeaves = await LeaveRequest.find({
    org_id: orgId,
    company_id: companyId,
    unit_id: unitId,
    employeeId: { $in: teamIds },
    status: "PENDING",
    isDeleted: false,
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate("employeeId", "name employeeId")
    .populate("leaveTypeId", "name code")
    .select("startDate endDate totalDays status createdAt")
    .lean();

  // 5. Team attendance summary for the month
  const teamAttSummary = await Attendance.aggregate([
    {
      $match: {
        org_id: toObjId(orgId),
        company_id: toObjId(companyId),
        unit_id: toObjId(unitId),
        employeeId: { $in: teamIds.map(id => toObjId(id)) },
        date: { $gte: monthStart, $lte: monthEnd },
      },
    },
    {
      $group: {
        _id: null,
        present: { $sum: { $cond: [{ $in: ["$status", ["PRESENT", "WFH", "LATE"]] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ["$status", "ABSENT"] }, 1, 0] } },
        late: { $sum: { $cond: [{ $eq: ["$status", "LATE"] }, 1, 0] } },
        onLeave: { $sum: { $cond: [{ $eq: ["$status", "ON_LEAVE"] }, 1, 0] } },
      },
    },
  ]);

  const attSummary = teamAttSummary[0] || { present: 0, absent: 0, late: 0, onLeave: 0 };

  // 6. Recent leaves from team (all statuses)
  const recentLeaves = await LeaveRequest.find({
    org_id: orgId,
    company_id: companyId,
    unit_id: unitId,
    employeeId: { $in: teamIds },
    isDeleted: false,
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate("employeeId", "name employeeId")
    .populate("leaveTypeId", "name code")
    .select("startDate endDate totalDays status createdAt")
    .lean();

  // 7. Upcoming holidays (filtered by unit for unit-level users)
  const upcomingHolidays = await Holiday.find({
    org_id: orgId,
    company_id: companyId,
    // Show holidays for manager's unit OR company-wide holidays
    ...(unitId && { $or: [{ unit_id: unitId }, { unit_id: null }] }),
    date: { $gte: new Date() },
    isDeleted: false,
  })
    .sort({ date: 1 })
    .limit(5)
    .select("name date")
    .lean();

  return {
    generatedAt: new Date(),
    month,
    manager: {
      id: managerEmployee._id,
      employeeId: managerEmployee.employeeId,
      name: managerEmployee.name,
      email: managerEmployee.email,
    },
    team: {
      total: teamMembers.length,
      members: teamMembers.slice(0, 10),
    },
    todayAttendance: {
      present: teamAttendanceToday.filter(a => ["PRESENT", "LATE", "WFH"].includes(a.status)).length,
      absent: teamAttendanceToday.filter(a => a.status === "ABSENT").length,
      onLeave: teamAttendanceToday.filter(a => a.status === "ON_LEAVE").length,
      late: teamAttendanceToday.filter(a => a.status === "LATE").length,
      records: teamAttendanceToday,
    },
    monthAttendance: attSummary,
    pendingLeaves: pendingLeaves.map(l => ({
      id: l._id,
      employee: l.employeeId ? { name: l.employeeId.name, employeeId: l.employeeId.employeeId } : null,
      leaveType: l.leaveTypeId ? { name: l.leaveTypeId.name, code: l.leaveTypeId.code } : null,
      startDate: l.startDate,
      endDate: l.endDate,
      totalDays: l.totalDays,
      status: l.status,
      appliedOn: l.createdAt,
    })),
    recentLeaves: recentLeaves.map(l => ({
      id: l._id,
      employee: l.employeeId ? { name: l.employeeId.name, employeeId: l.employeeId.employeeId } : null,
      leaveType: l.leaveTypeId ? { name: l.leaveTypeId.name, code: l.leaveTypeId.code } : null,
      startDate: l.startDate,
      endDate: l.endDate,
      totalDays: l.totalDays,
      status: l.status,
      appliedOn: l.createdAt,
    })),
    holidays: upcomingHolidays.map(h => ({
      id: h._id,
      name: h.name,
      date: h.date,
    })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. SUPER ADMIN DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

exports.getSuperAdminDashboard = async () => {
  const now            = new Date();
  const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [customerStats, recentCustomers, plans, userStats, auditLogs, planCounts] = await Promise.all([

    Customer.aggregate([
      { $match: { is_deleted: false } },
      { $group: {
        _id:          null,
        total:        { $sum: 1 },
        active:       { $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] } },
        suspended:    { $sum: { $cond: [{ $eq: ["$status", "Suspended"] }, 1, 0] } },
        newThisMonth: { $sum: { $cond: [{ $gte: ["$createdAt", thisMonthStart] }, 1, 0] } },
      }},
    ]),

    Customer.find({ is_deleted: false })
      .sort({ createdAt: -1 })
      .limit(8)
      .select("business_name contact_email contact_phone status createdAt")
      .lean(),

    Plan.find({}).select("name price_monthly structure_level status").lean().catch(() => []),

    User.aggregate([
      { $group: {
        _id:    null,
        total:  { $sum: 1 },
        active: { $sum: { $cond: [{ $eq: ["$is_deleted", false] }, 1, 0] } },
      }},
    ]),

    AuditLog.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .select("action actorEmail details createdAt")
      .lean()
      .catch(() => []),

    // FIX 4: Single aggregate instead of N+1 loop
    Subscription.aggregate([
      { $match: { is_active: true } },
      { $group: { _id: "$plan_snapshot.name", count: { $sum: 1 } } },
    ]),
  ]);

  const cStats = customerStats[0] || { total: 0, active: 0, suspended: 0, newThisMonth: 0 };
  const uStats = userStats[0]     || { total: 0, active: 0 };

  // FIX 4: Build planBreakdown from aggregate result
  const planCountMap = {};
  planCounts.forEach((p) => { planCountMap[p._id] = p.count; });

  const planBreakdown = plans.map((p) => ({
    id:             p._id,
    name:           p.name,
    price:          p.price_monthly,
    structureLevel: p.structure_level,
    status:         p.status,
    orgCount:       planCountMap[p.name] || 0,
  }));

  return {
    generatedAt: new Date(),
    customers: {
      total:        cStats.total,
      active:       cStats.active,
      suspended:    cStats.suspended,
      newThisMonth: cStats.newThisMonth,
    },
    users:  { total: uStats.total, active: uStats.active },
    plans:  planBreakdown,
    recentCustomers: recentCustomers.map((c) => ({
      id:        c._id,
      name:      c.business_name,
      email:     c.contact_email,
      phone:     c.contact_phone,
      status:    c.status,
      joinedAt:  c.createdAt,
    })),
    recentActivity: auditLogs.map((a) => ({
      action:    a.action,
      actor:     a.actorEmail,
      details:   a.details,
      timestamp: a.createdAt,
    })),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. CUSTOMER DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

exports.getCustomerDashboard = async (customer) => {
  const orgs = await Organization.find({
    customer_id: customer._id,
    is_deleted:  false,
  }).select("name slug status contact_email createdAt").lean();

  // FIX 5: Add subscription info per org
  const orgsWithSub = await Promise.all(orgs.map(async (org) => {
    const sub = await Subscription.findOne({
      org_id:    org._id,
      is_active: true,
    }).select("plan_snapshot status ends_at").lean();

    const daysLeft = sub?.ends_at
      ? Math.max(0, Math.ceil((new Date(sub.ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
      : null;

    return {
      id:           org._id,
      name:         org.name,
      slug:         org.slug,
      status:       org.status,
      contact_email: org.contact_email,
      createdAt:    org.createdAt,
      plan:         sub?.plan_snapshot?.name   || null,
      subscription_status: sub?.status         || null,
      days_left:    daysLeft,
      is_trial:     sub?.status === "Trial",
    };
  }));

  return {
    customer: {
      id:            customer._id,
      name:          customer.contact_name,
      email:         customer.contact_email,
      business_name: customer.business_name,
    },
    organisations: orgsWithSub,
    org_count:     orgs.length,
  };
};