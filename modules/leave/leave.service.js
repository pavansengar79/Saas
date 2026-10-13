// modules/leave/leave.service.js
// REFACTORED — Dynamic Leave Management (Policy-Driven)
// Leave balances are calculated in REAL-TIME from Active Leave Policy
// No seeding, no initialization, no permanent balance storage

const LeavePolicy  = require("../leavePolicy/models/leavePolicy.model");
const LeaveType    = require("./models/leaveType.models");
const LeaveRequest = require("./models/leaveRequest.models");
const Employee     = require("../employee/models/employee.model");
const AppError     = require("../../utils/appError");
const mongoose     = require("mongoose");
const { resolveLeaveTypeScope } = require("./leaveTypeScope");

const toObjId = (id) => new mongoose.Types.ObjectId(String(id));

// ── Scope filter ──────────────────────────────────────────
const buildScopeFilter = (user) => {
  if (user.role === "SUPER_ADMIN") return {};
  const filter = { org_id: user.orgId };
  if (user.companyId) filter.company_id = user.companyId;
  if (user.unitId)    filter.unit_id    = user.unitId;
  return filter;
};

const throwDuplicateLeaveType = (error, code) => {
  if (error?.code === 11000) {
    throw new AppError(`Leave type with code '${code}' already exists in this company`, 409);
  }
  throw error;
};

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC LEAVE BALANCE CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get active leave policy for an employee
 */
const getActiveLeavePolicy = async (org_id, company_id, unit_id) => {
  console.log("[LEAVE POLICY] Looking for policy - org:", org_id, "company:", company_id, "unit:", unit_id);
  
  // Try unit-specific policy first
  if (unit_id) {
    const unitPolicy = await LeavePolicy.findOne({
      org_id,
      company_id,
      unit_id: toObjId(unit_id),
      status: "active",
      isDeleted: { $ne: true }, // Match false, null, or undefined
    });
    
    if (unitPolicy) {
      console.log("[LEAVE POLICY] Found UNIT policy:", unitPolicy.name, "with", unitPolicy.leaveTypes?.length, "leave types");
      console.log("[LEAVE POLICY] Unit leave types:", unitPolicy.leaveTypes?.map(lt => ({ name: lt.name, code: lt.code, active: lt.isActive })));
      return unitPolicy;
    }
    console.log("[LEAVE POLICY] No unit policy found for unit_id:", unit_id);
  }

  // Fallback to company-level policy (unit_id: null)
  console.log("[LEAVE POLICY] FALLING BACK to company policy...");
  const companyPolicy = await LeavePolicy.findOne({
    org_id,
    company_id,
    unit_id: null,
    status: "active",
    isDeleted: { $ne: true }, // Match false, null, or undefined
  });

  if (companyPolicy) {
    console.log("[LEAVE POLICY] Found COMPANY policy:", companyPolicy.name, "with", companyPolicy.leaveTypes?.length, "leave types");
    console.log("[LEAVE POLICY] Company leave types:", companyPolicy.leaveTypes?.map(lt => ({ name: lt.name, code: lt.code, active: lt.isActive })));
  }

  return companyPolicy;
};

/**
 * Calculate leave usage from approved/pending leave requests
 */
const calculateLeaveUsage = async (employeeId, leaveTypeId, year) => {
  const startOfYear = new Date(year, 0, 1);
  const endOfYear = new Date(year, 11, 31, 23, 59, 59);

  // APPROVED leaves = used
  // FIX: Use $totalDays (not numberOfDays), fix date range for cross-year leaves
  const usedAgg = await LeaveRequest.aggregate([
    {
      $match: {
        employeeId: toObjId(employeeId),
        leaveTypeId: toObjId(leaveTypeId),
        status: "APPROVED",
        startDate: { $lte: endOfYear },  // Started before end of year
        endDate: { $gte: startOfYear },   // Ends after start of year
        isDeleted: false,
      },
    },
    { $group: { _id: null, totalDays: { $sum: "$totalDays" } } },
  ]);

  // PENDING + UNDER_REVIEW leaves = pending
  // UNDER_REVIEW = L1 approved, waiting for L2. Those days are still reserved;
  // leaving them out let employees apply beyond their balance in that window.
  const pendingAgg = await LeaveRequest.aggregate([
    {
      $match: {
        employeeId: toObjId(employeeId),
        leaveTypeId: toObjId(leaveTypeId),
        status: { $in: ["PENDING", "UNDER_REVIEW"] },
        startDate: { $lte: endOfYear },  // Started before end of year
        endDate: { $gte: startOfYear },   // Ends after start of year
        isDeleted: false,
      },
    },
    { $group: { _id: null, totalDays: { $sum: "$totalDays" } } },
  ]);

  return {
    used: usedAgg[0]?.totalDays || 0,
    pending: pendingAgg[0]?.totalDays || 0,
  };
};

/**
 * Calculate dynamic leave balances for an employee
 * Source of truth: Active Leave Policy
 */
const calculateDynamicLeaveBalances = async (employeeId, year) => {
  const targetYear = year || new Date().getFullYear();

  const employee = await Employee.findById(employeeId)
    .select("name employeeId org_id company_id unit_id status")
    .populate("unit_id", "name");

  if (!employee) throw new AppError("Employee not found", 404);

  // Get active leave policy
  const activePolicy = await getActiveLeavePolicy(
    employee.org_id,
    employee.company_id,
    employee.unit_id?._id || employee.unit_id
  );

  if (!activePolicy) {
    return {
      employee: {
        id: employee._id,
        name: employee.name,
        employeeId: employee.employeeId,
      },
      policy: null,
      balances: [],
      summary: {
        totalLeaveTypes: 0,
        totalAllocated: 0,
        totalUsed: 0,
        totalPending: 0,
        totalRemaining: 0,
      },
    };
  }

  // Build balances from policy leave types
  const balances = [];
  let totalAllocated = 0;
  let totalUsed = 0;
  let totalPending = 0;
  let totalRemaining = 0;

  for (const plt of activePolicy.leaveTypes) {
    if (!plt.isActive) continue;

    const leaveTypeId = plt.leaveTypeId || null;
    const leaveType = leaveTypeId
      ? await LeaveType.findById(leaveTypeId).select("name code isPaid colorCode isHalfDayAllowed")
      : null;

    const allocated = plt.credit?.totalPerYear || 0;
    const usage = leaveTypeId
      ? await calculateLeaveUsage(employeeId, leaveTypeId, targetYear)
      : { used: 0, pending: 0 };

    const remaining = Math.max(0, allocated - usage.used - usage.pending);

    // Prefer policy leave type name (plt.name), fallback to master catalog (leaveType.name)
    const leaveTypeName = plt.name || leaveType?.name || plt.code || "Unknown Leave";

    console.log(`[LEAVE BALANCE] Leave type: ${leaveTypeName}, code: ${plt.code}, allocated: ${allocated}, used: ${usage.used}, pending: ${usage.pending}`);

    balances.push({
      leaveTypeId: {
        _id: leaveTypeId || plt._id,
        name: leaveTypeName,
        code: plt.code,
        colorCode: plt.color || leaveType?.colorCode || "#6B7280",
        isPaid: plt.isPaid ?? leaveType?.isPaid ?? true,
        isHalfDayAllowed: plt.isHalfDayAllowed ?? leaveType?.isHalfDayAllowed ?? true,
      },
      allocated,
      used: usage.used,
      pending: usage.pending,
      remaining,
      policyName: activePolicy.name,
    });

    totalAllocated += allocated;
    totalUsed += usage.used;
    totalPending += usage.pending;
    totalRemaining += remaining;
  }

  return {
    employee: {
      id: employee._id,
      name: employee.name,
      employeeId: employee.employeeId,
      unit: employee.unit_id,
    },
    policy: {
      id: activePolicy._id,
      name: activePolicy.name,
      version: activePolicy.version,
    },
    year: targetYear,
    balances,
    summary: {
      totalLeaveTypes: balances.length,
      totalAllocated,
      totalUsed,
      totalPending,
      totalRemaining,
    },
  };
};

// ─── CREATE LEAVE TYPE ────────────────────────────────────
exports.create = async (payload, user, query = {}) => {
  const { name, code } = payload;
  const scope = await resolveLeaveTypeScope(user, query, true);

  const existing = await LeaveType.findOne({
    ...scope,
    code:       code.toUpperCase(),
    isDeleted:  false,
  });
  if (existing) throw new AppError(`Leave type with code '${code}' already exists in this company`, 409);

  try {
    return await LeaveType.create({
      ...payload,
      code:       code.toUpperCase(),
      ...scope,
      isSystem:   false,
      createdBy:  user.userId,
    });
  } catch (error) {
    throwDuplicateLeaveType(error, code);
  }
};

// ─── GET ALL LEAVE TYPES ──────────────────────────────────
exports.getAll = async (query, user) => {
  const { isActive, isPaid, search } = query;
  const scope = await resolveLeaveTypeScope(user, query);

  const filter = {
    ...scope,
    isDeleted: false,
  };

  if (isActive !== undefined) filter.isActive = isActive === "true";
  if (isPaid   !== undefined) filter.isPaid   = isPaid   === "true";

  if (search) {
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { name: { $regex: escapedSearch, $options: "i" } },
      { code: { $regex: escapedSearch, $options: "i" } },
    ];
  }

  return await LeaveType.find(filter).sort({ isSystem: -1, name: 1 });
};

// ─── GET ONE LEAVE TYPE ───────────────────────────────────
exports.getOne = async (id, user, query = {}) => {
  const scope = await resolveLeaveTypeScope(user, query);
  const leaveType = await LeaveType.findOne({
    _id:       id,
    ...scope,
    isDeleted: false,
  });
  if (!leaveType) throw new AppError("Leave type not found", 404);
  return leaveType;
};

// ─── UPDATE LEAVE TYPE ────────────────────────────────────
exports.update = async (id, payload, user, query = {}) => {
  const scope = await resolveLeaveTypeScope(user, query, true);
  const leaveType = await LeaveType.findOne({
    _id:       id,
    ...scope,
    isDeleted: false,
  });
  if (!leaveType) throw new AppError("Leave type not found", 404);

  if (leaveType.isSystem) throw new AppError("System leave types cannot be modified", 400);

  if (payload.code && payload.code.toUpperCase() !== leaveType.code) {
    const existing = await LeaveType.findOne({
      ...scope,
      code:       payload.code.toUpperCase(),
      isDeleted:  false,
      _id:        { $ne: id },
    });
    if (existing) throw new AppError(`Leave type with code '${payload.code}' already exists`, 409);
    payload.code = payload.code.toUpperCase();
  }

  delete payload.isSystem;
  delete payload.org_id;
  delete payload.company_id;

  Object.assign(leaveType, { ...payload, updatedBy: user.userId });
  try {
    await leaveType.save();
  } catch (error) {
    throwDuplicateLeaveType(error, payload.code || leaveType.code);
  }
  return leaveType;
};

// ─── DELETE LEAVE TYPE ────────────────────────────────────
exports.remove = async (id, user, query = {}) => {
  const scope = await resolveLeaveTypeScope(user, query, true);
  const leaveType = await LeaveType.findOne({
    _id:       id,
    ...scope,
    isDeleted: false,
  });
  if (!leaveType) throw new AppError("Leave type not found", 404);
  if (leaveType.isSystem) throw new AppError("System leave types cannot be deleted", 400);

  leaveType.isDeleted = true;
  leaveType.updatedBy = user.userId;
  await leaveType.save();
  return { message: "Leave type deleted successfully" };
};

// ─── TOGGLE STATUS ────────────────────────────────────────
exports.toggleStatus = async (id, user) => {
  const leaveType = await LeaveType.findOne({
    _id:       id,
    ...buildCompanyFilter(user),
    isDeleted: false,
  });
  if (!leaveType) throw new AppError("Leave type not found", 404);
  if (leaveType.isSystem) throw new AppError("System leave types cannot be deactivated", 400);

  leaveType.isActive  = !leaveType.isActive;
  leaveType.updatedBy = user.userId;
  await leaveType.save();

  return {
    message:  `Leave type ${leaveType.isActive ? "activated" : "deactivated"} successfully`,
    isActive: leaveType.isActive,
  };
};

// ─── INITIALIZE LEAVE BALANCE ─────────────────────────────
// DEPRECATED — Balances are now calculated dynamically from policy
// Keeping for backward compatibility but returns calculated balance
exports.initializeLeaveBalance = async (body, user) => {
  const { employeeId, year = new Date().getFullYear() } = body;

  // Return dynamic calculation instead
  const result = await calculateDynamicLeaveBalances(employeeId, year);
  return {
    message: "Leave balances are now calculated dynamically from active policy",
    data: result,
  };
};

// ─── GET LEAVE BALANCES (Dynamic Calculation) ───────────────────────────────
exports.getLeaveBalances = async (employeeId, query, user) => {
  const year = query.year || new Date().getFullYear();

  // Verify employee access
  const employee = await Employee.findOne({
    _id: employeeId,
    org_id: user.orgId,
    company_id: user.companyId,
    isDeleted: false,
  }).select("_id");

  if (!employee) throw new AppError("Employee not found", 404);

  // Return dynamic calculation
  return await calculateDynamicLeaveBalances(employeeId, year);
};

// ─── GET MY LEAVE BALANCES (Dynamic Calculation) ────────────────────────────────
exports.getMyLeaveBalances = async (query, user) => {
  const year = query.year || new Date().getFullYear();

  const employee = await Employee.findOne({
    userId: user.userId,
    org_id: user.orgId,
    company_id: user.companyId,
    isDeleted: false,
  }).select("_id");

  if (!employee) throw new AppError("Employee record not found for your account", 404);

  // Return dynamic calculation
  return await calculateDynamicLeaveBalances(employee._id, year);
};

// ─── ADJUST LEAVE BALANCE ─────────────────────────────────
// DEPRECATED — Balances are now calculated dynamically
// Manual adjustments should be handled via LeaveAdjustment model if needed
exports.adjustLeaveBalance = async (balanceId, body, user) => {
  throw new AppError(
    "Leave balance adjustments are deprecated. Balances are now calculated dynamically from the active leave policy. To modify allocations, update the policy instead.",
    400
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// AVAILABLE LEAVE TYPES (From Active Policy)
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET AVAILABLE LEAVE TYPES FOR EMPLOYEE (From Policy) ────────────────────────
exports.getAvailableLeaveTypes = async (user) => {
  const employee = await Employee.findOne({
    userId: user.userId,
    org_id: user.orgId,
    company_id: user.companyId,
    isDeleted: false,
  }).select("unit_id");

  if (!employee) throw new AppError("Employee record not found", 404);

  const activePolicy = await getActiveLeavePolicy(
    user.orgId,
    user.companyId,
    employee.unit_id
  );

  if (!activePolicy) return [];

  const leaveTypes = [];
  for (const plt of activePolicy.leaveTypes) {
    if (!plt.isActive) continue;

    const leaveType = plt.leaveTypeId
      ? await LeaveType.findById(plt.leaveTypeId).select("name code colorCode isPaid isHalfDayAllowed")
      : null;

    leaveTypes.push({
      _id: plt.leaveTypeId || plt._id,
      code: plt.code,
      name: plt.name || leaveType?.name,
      isPaid: plt.isPaid ?? leaveType?.isPaid ?? true,
      colorCode: leaveType?.colorCode || "#6B7280",
      isHalfDayAllowed: leaveType?.isHalfDayAllowed ?? true,
      totalPerYear: plt.credit?.totalPerYear || 0,
    });
  }

  return leaveTypes;
};

// ─── GET ALL LEAVE TYPES FOR HR (Master Catalog) ────────────────────────
exports.getAllLeaveTypesForHR = async (user) => {
  return await LeaveType.find({
    ...buildCompanyFilter(user),
    isDeleted: false,
  }).sort({ isSystem: -1, name: 1 });
};

// Export helper for use in other modules
exports.calculateDynamicLeaveBalances = calculateDynamicLeaveBalances;
exports.getActiveLeavePolicy = getActiveLeavePolicy;
exports.calculateLeaveUsage = calculateLeaveUsage;
// ─── TEAM LEAVE CALENDAR ──────────────────────────────────────
// GET /leave/calendar?month=YYYY-MM&unit_id=&department_id=
//
// Returns month-wise view of who is on leave when.
// Used by: manager (own team), hr_manager (full unit), employee (own unit view)
//
// Dynamic:
//   - Scope: manager → sirf reportingManagerId wale employees
//             hr_manager/unit_admin → poora unit
//             company_admin/org_admin → filter by unit_id param
//   - department_id filter optional
//   - Response includes dailySummary for frontend grid
//   - Only APPROVED leaves shown (not pending/draft)

const fmtDateStr = (d) => {
  if (!d) return "";
  return new Date(d).toISOString().split("T")[0]; // "YYYY-MM-DD"
};

exports.getTeamCalendar = async (query, user) => {
  const { month, unit_id, department_id } = query;

  if (!month) throw new AppError("month is required (format: YYYY-MM)", 400);
  const [yr, mo] = month.split("-").map(Number);
  if (!yr || !mo || mo < 1 || mo > 12) {
    throw new AppError("Invalid month format. Use YYYY-MM", 400);
  }

  const monthStart = new Date(yr, mo - 1, 1);
  const monthEnd   = new Date(yr, mo, 0);
  monthEnd.setHours(23, 59, 59, 999);

  // ── Build scope ──────────────────────────────────────────────
  const requestFilter = {
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    status:     "APPROVED",
    startDate:  { $lte: monthEnd },
    endDate:    { $gte: monthStart },
  };

  const targetUnitId = unit_id || user.unitId;
  if (targetUnitId) requestFilter.unit_id = toObjId(targetUnitId);

  // ── Fetch approved leaves ────────────────────────────────────
  const leaves = await LeaveRequest.find(requestFilter)
    .populate({
      path:   "employeeId",
      select: "name employeeId departmentId",
      match:  department_id
        ? { departmentId: toObjId(department_id), isDeleted: false }
        : { isDeleted: false },
    })
    .populate("leaveTypeId", "name code colorCode")
    .lean();

  // Filter out nulls from department match
  const validLeaves = leaves.filter((l) => l.employeeId !== null);

  // ── Manager scope — sirf apni team ──────────────────────────
  // If manager role: further filter to employees who have this manager as reportingManagerId
  let filteredLeaves = validLeaves;
  if (user.roleSlug === "manager") {
    const myTeam = await Employee.find({
      reportingManagerId: toObjId(user.employeeId || "000000000000000000000000"),
      org_id:             toObjId(user.orgId),
      company_id:         toObjId(user.companyId),
      isDeleted:          false,
      status:             "ACTIVE",
    }).select("_id").lean();

    const teamIds = new Set(myTeam.map((e) => e._id.toString()));
    filteredLeaves = validLeaves.filter(
      (l) => teamIds.has(l.employeeId._id.toString())
    );
  }

  // ── Build employee map ───────────────────────────────────────
  const employeeMap = new Map();
  const daysInMonth = new Date(yr, mo, 0).getDate();

  for (const leave of filteredLeaves) {
    const empId  = leave.employeeId._id.toString();
    const emp    = leave.employeeId;
    const lt     = leave.leaveType;

    if (!employeeMap.has(empId)) {
      employeeMap.set(empId, {
        employee: {
          id:           emp._id,
          name:         emp.name,
          employeeId:   emp.employeeId,
          departmentId: emp.departmentId,
        },
        leaves:       [],
        leaveDates:   [], // flat array of "YYYY-MM-DD" strings for this month
      });
    }

    const entry = employeeMap.get(empId);

    entry.leaves.push({
      leaveId:   leave._id,
      startDate: leave.startDate,
      endDate:   leave.endDate,
      totalDays: leave.totalDays,
      leaveType: leave.leaveTypeId
        ? { name: leave.leaveTypeId.name, code: leave.leaveTypeId.code, color: leave.leaveTypeId.colorCode }
        : null,
      isHalfDay: leave.isHalfDay,
      session:   leave.session,
    });

    // Build flat date array clipped to this month
    const rangeStart = new Date(Math.max(new Date(leave.startDate), monthStart));
    const rangeEnd   = new Date(Math.min(new Date(leave.endDate),   monthEnd));
    const cur        = new Date(rangeStart);
    while (cur <= rangeEnd) {
      const ds = fmtDateStr(cur);
      if (!entry.leaveDates.includes(ds)) entry.leaveDates.push(ds);
      cur.setDate(cur.getDate() + 1);
    }
  }

  // ── Build dailySummary ───────────────────────────────────────
  // { "2026-06-05": { count: 3, employees: ["Rahul", "Priya"] } }
  const dailySummary = {};
  for (const entry of employeeMap.values()) {
    for (const dateStr of entry.leaveDates) {
      if (!dailySummary[dateStr]) {
        dailySummary[dateStr] = { count: 0, employees: [] };
      }
      dailySummary[dateStr].count++;
      dailySummary[dateStr].employees.push(entry.employee.name);
    }
  }

  return {
    month,
    daysInMonth,
    totalOnLeave:  employeeMap.size,
    employees:     Array.from(employeeMap.values()),
    dailySummary,
  };
};

// ─── LEAVE LIABILITY REPORT ───────────────────────────────────
// GET /leave/reports/liability?unit_id=&department_id=&asOfDate=
//
// Finance report: agar aaj sab employees ne apni encashable leave
// cash karwa li toh company ko kitna paisa dena padega?
//
// Dynamic:
//   - Only leaveTypes with isEncashmentAllowed: true
//   - encashableLimit pe cap: Math.min(balance, encashableLimit ?? Infinity)
//   - minBalanceAfterEncashment: employee must retain this much
//   - encashmentBasis: BASIC / GROSS / LAST_DRAWN → salary / 26 × days
//   - encashmentTrigger filter: YEAR_END + ON_RESIGN types included
//     ANYTIME always included
//   - Grouped by department in response

exports.getLeaveLiabilityReport = async (query, user) => {
  const { unit_id, department_id, asOfDate } = query;

  const asOf = asOfDate ? new Date(asOfDate) : new Date();

  // ── Scope ────────────────────────────────────────────────────
  const empFilter = {
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    isDeleted:  false,
    status:     "ACTIVE",
  };
  if (unit_id || user.unitId)     empFilter.unit_id     = toObjId(unit_id || user.unitId);
  if (department_id)               empFilter.departmentId = toObjId(department_id);

  // ── Get all active employees in scope ────────────────────────
  const employees = await Employee.find(empFilter)
    .select("name employeeId departmentId salary")
    .lean();

  if (employees.length === 0) {
    return {
      asOfDate:       fmtDateStr(asOf),
      totalEmployees: 0,
      totalLiability: 0,
      currency:       "INR",
      employees:      [],
      byDepartment:   [],
    };
  }

  // ── Get encashable leave types for this company ──────────────
  const encashableTypes = await LeaveType.find({
    org_id:               toObjId(user.orgId),
    company_id:           toObjId(user.companyId),
    isEncashmentAllowed:  true,
    isDeleted:            false,
    isActive:             true,
  }).lean();

  if (encashableTypes.length === 0) {
    return {
      asOfDate:       fmtDateStr(asOf),
      totalEmployees: employees.length,
      totalLiability: 0,
      currency:       "INR",
      note:           "No encashable leave types configured for this company",
      employees:      [],
      byDepartment:   [],
    };
  }

  const encashableTypeMap = new Map(encashableTypes.map((t) => [t._id.toString(), t]));
  const employeeIds       = employees.map((e) => e._id);

  // ── Get leave balances for all employees + encashable types ──
  const balances = await LeaveBalance.find({
    org_id:      toObjId(user.orgId),
    company_id:  toObjId(user.companyId),
    employeeId:  { $in: employeeIds },
    leaveTypeId: { $in: encashableTypes.map((t) => t._id) },
  }).lean();

  // Group balances by employeeId
  const balanceMap = new Map();
  for (const bal of balances) {
    const eid = bal.employeeId.toString();
    if (!balanceMap.has(eid)) balanceMap.set(eid, []);
    balanceMap.get(eid).push(bal);
  }

  // ── Calculate liability per employee ─────────────────────────
  const employeeResults = [];
  const deptMap         = new Map();

  for (const emp of employees) {
    const empBalances   = balanceMap.get(emp._id.toString()) || [];
    let   totalEncashable = 0;
    let   totalLiability  = 0;
    const breakdown       = [];

    for (const bal of empBalances) {
      const lt = encashableTypeMap.get(bal.leaveTypeId.toString());
      if (!lt) continue;

      const remaining = bal.remaining || 0;

      // Min balance employee must retain
      const minRetain    = lt.minBalanceAfterEncashment ?? 0;
      const availableForEncash = Math.max(0, remaining - minRetain);
      if (availableForEncash <= 0) continue;

      // Apply encashable limit cap
      const cap          = lt.encashableLimit ?? Infinity;
      const encashableDays = Math.min(availableForEncash, cap);
      if (encashableDays <= 0) continue;

      // Daily rate based on encashmentBasis
      // salary object: { basic, gross, ... } — use emp.salary fields
      let salaryBasis = 0;
      const salaryObj = emp.salary || {};
      if (lt.encashmentBasis === "GROSS") {
        salaryBasis = salaryObj.grossSalary || salaryObj.gross || salaryObj.ctc || 0;
      } else if (lt.encashmentBasis === "LAST_DRAWN") {
        // Last drawn = gross (for now; payslip integration can refine later)
        salaryBasis = salaryObj.grossSalary || salaryObj.gross || salaryObj.ctc || 0;
      } else {
        // Default: BASIC
        salaryBasis = salaryObj.basicSalary || salaryObj.basic || 0;
      }

      const dailyRate    = salaryBasis > 0 ? Math.round(salaryBasis / 26) : 0;
      const liability    = Math.round(encashableDays * dailyRate);

      totalEncashable   += encashableDays;
      totalLiability    += liability;

      breakdown.push({
        leaveType:       lt.name,
        leaveCode:       lt.code,
        balance:         remaining,
        minRetain,
        encashableDays,
        dailyRate,
        liability,
        encashmentBasis: lt.encashmentBasis,
        encashmentTrigger: lt.encashmentTrigger,
      });
    }

    if (breakdown.length === 0) continue; // no encashable balance

    const result = {
      employeeId:     emp._id,
      employeeCode:   emp.employeeId,
      name:           emp.name,
      departmentId:   emp.departmentId,
      totalEncashableDays: Math.round(totalEncashable * 10) / 10,
      totalLiability,
      breakdown,
    };
    employeeResults.push(result);

    // Dept aggregation
    const deptId = emp.departmentId?.toString() || "unassigned";
    if (!deptMap.has(deptId)) {
      deptMap.set(deptId, { departmentId: emp.departmentId, totalDays: 0, totalLiability: 0, count: 0 });
    }
    const deptEntry = deptMap.get(deptId);
    deptEntry.totalDays      += totalEncashable;
    deptEntry.totalLiability += totalLiability;
    deptEntry.count++;
  }

  // ── Grand total ──────────────────────────────────────────────
  const grandTotal = employeeResults.reduce((sum, e) => sum + e.totalLiability, 0);

  return {
    asOfDate:       fmtDateStr(asOf),
    totalEmployees: employeeResults.length,
    totalLiability: grandTotal,
    currency:       "INR",
    employees:      employeeResults.sort((a, b) => b.totalLiability - a.totalLiability),
    byDepartment:   Array.from(deptMap.values()).map((d) => ({
      ...d,
      totalDays:      Math.round(d.totalDays * 10) / 10,
    })),
  };
};