// utils/policyResolver.js
// UPDATED — tenantId → org_id + company_id + unit_id
// UPDATED — added designation-level scope matching (between role and department)
//
// Policy Resolution Engine
// Resolves correct LeavePolicy / AttendancePolicy / PayrollPolicy
// for a given employee using 6-level priority:
//
//   1. role match        → applicableFor.roles includes employee's role slug         (score 6)
//   2. designation match  → applicableFor.designations includes employee's designation (score 5)
//   3. department match   → applicableFor.departments includes employee's dept        (score 4)
//   4. location match     → applicableFor.locations includes employee's city          (score 3)
//   5. employmentType     → applicableFor.employmentTypes includes employee's type    (score 2)
//   6. default            → applicableFor is completely empty (catch-all)             (score 1)

"use strict";

const AppError         = require("./appError");
const Employee         = require("../modules/employee/models/employee.model");
const User             = require("../modules/auth/models/user.model");
const Role             = require("../modules/role/role.model");
const LeavePolicy      = require("../modules/leavePolicy/models/leavePolicy.model");
const AttendancePolicy = require("../modules/attendancePolicy/models/attendancePolicy.model");
const PayrollPolicy    = require("../modules/payrollPolicy/models/payrollPolicy.model");

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const _cache = new Map();

// Cache key — company_id + unit_id + employeeId
const _cacheKey = (type, company_id, employeeId) =>
  `${type}:${company_id}:${employeeId}`;

const _cacheGet = (key) => {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.value;
};

const _cacheSet = (key, value) => {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
};

// Called when policy changes status — invalidate by company
const invalidatePolicyCache = (type, company_id) => {
  const prefix = `${type}:${company_id}:`;
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
};

// Called when employee dept/role changes
const invalidateEmployeeCache = (company_id, employeeId) => {
  for (const type of ["leave", "attendance", "payroll"]) {
    _cache.delete(_cacheKey(type, company_id, employeeId));
  }
};

// ─── Employee Context Loader ──────────────────────────────────────────────────
const _loadEmployeeContext = async (employeeId, company_id) => {
  const employee = await Employee.findOne({
    _id:        employeeId,
    company_id,
    isDeleted:  false,
  })
    .select("userId departmentId designationId currentAddress employmentType status unit_id")
    .lean();

  if (!employee) throw new AppError("Employee not found", 404);

  let roleSlug = null;
  if (employee.userId) {
    const user = await User.findOne({
      _id:       employee.userId,
      isDeleted: false,
    }).select("roleId").lean();

    if (user?.roleId) {
      const role = await Role.findById(user.roleId).select("slug").lean();
      roleSlug = role?.slug || null;
    }
  }

  return {
    roleSlug,
    departmentId:   employee.departmentId?.toString()      || null,
    designationId:  employee.designationId?.toString()     || null,
    city:           employee.currentAddress?.city          || null,
    employmentType: employee.employmentType                || null,
    unit_id:        employee.unit_id?.toString()           || null,
  };
};

// ─── Score Policy ─────────────────────────────────────────────────────────────
const _scorePolicy = (policy, ctx) => {
  const af = policy.applicableFor || {};

  const hasRoles        = af.roles           && af.roles.length > 0;
  const hasDesignations = af.designations    && af.designations.length > 0;
  const hasDepts        = af.departments     && af.departments.length > 0;
  const hasLocations     = af.locations       && af.locations.length > 0;
  const hasEmpTypes     = af.employmentTypes && af.employmentTypes.length > 0;

  const isDefault = !hasRoles && !hasDesignations && !hasDepts && !hasLocations && !hasEmpTypes;
  if (isDefault) return 1;

  // 6 — role match (highest priority)
  if (hasRoles && ctx.roleSlug && af.roles.includes(ctx.roleSlug)) return 6;

  // 5 — designation match
  if (hasDesignations && ctx.designationId) {
    const desigIds = af.designations.map((d) => d._id ? d._id.toString() : d.toString());
    if (desigIds.includes(ctx.designationId)) return 5;
  }

  // 4 — department match
  if (hasDepts && ctx.departmentId) {
    const deptIds = af.departments.map((d) => d._id ? d._id.toString() : d.toString());
    if (deptIds.includes(ctx.departmentId)) return 4;
  }

  // 3 — location match
  if (hasLocations && ctx.city) {
    const normalized = af.locations.map((l) => l.trim().toLowerCase());
    if (normalized.includes(ctx.city.trim().toLowerCase())) return 3;
  }

  // 2 — employment type match
  if (hasEmpTypes && ctx.employmentType) {
    if (af.employmentTypes.includes(ctx.employmentType)) return 2;
  }

  return -1;
};

// ─── Core Resolver ────────────────────────────────────────────────────────────
const _resolve = async (Model, company_id, unit_id, ctx, policyTypeName) => {
  const filter = { company_id, status: "active" };
  if (unit_id) filter.unit_id = unit_id;

  const policies = await Model.find(filter)
    .select("name status applicableFor activatedAt createdAt")
    .lean();

  // If no unit-specific policies — fallback to company-level
  let allPolicies = policies;
  if (!allPolicies.length && unit_id) {
    allPolicies = await Model.find({ company_id, status: "active" })
      .select("name status applicableFor activatedAt createdAt")
      .lean();
  }

  if (!allPolicies.length) {
    throw new AppError(`No active ${policyTypeName} policy configured`, 422);
  }

  const scored = allPolicies
    .map((p) => ({ policy: p, score: _scorePolicy(p, ctx) }))
    .filter((entry) => entry.score > 0);

  if (!scored.length) {
    throw new AppError(
      `No ${policyTypeName} policy configured for this employee. Contact HR.`,
      422
    );
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = a.policy.activatedAt ? new Date(a.policy.activatedAt).getTime() : new Date(a.policy.createdAt).getTime();
    const bTime = b.policy.activatedAt ? new Date(b.policy.activatedAt).getTime() : new Date(b.policy.createdAt).getTime();
    return bTime - aTime;
  });

  return scored[0].policy;
};

// ─── Public API ───────────────────────────────────────────────────────────────
const resolveLeavePolicy = async (employeeId, company_id, unit_id = null) => {
  const key    = _cacheKey("leave", company_id, employeeId);
  const cached = _cacheGet(key);
  if (cached) return cached;

  const ctx    = await _loadEmployeeContext(employeeId, company_id);
  const policy = await _resolve(LeavePolicy, company_id, unit_id || ctx.unit_id, ctx, "leave");
  const full   = await LeavePolicy.findById(policy._id).lean();

  _cacheSet(key, full);
  return full;
};

const resolveAttendancePolicy = async (employeeId, company_id, unit_id = null) => {
  const key    = _cacheKey("attendance", company_id, employeeId);
  const cached = _cacheGet(key);
  if (cached) return cached;

  const ctx    = await _loadEmployeeContext(employeeId, company_id);
  const policy = await _resolve(AttendancePolicy, company_id, unit_id || ctx.unit_id, ctx, "attendance");
  const full   = await AttendancePolicy.findById(policy._id).lean();

  _cacheSet(key, full);
  return full;
};

const resolvePayrollPolicy = async (employeeId, company_id, unit_id = null, { fresh = false } = {}) => {
  const key    = _cacheKey("payroll", company_id, employeeId);
  const cached = fresh ? null : _cacheGet(key);
  if (cached) return cached;

  const ctx    = await _loadEmployeeContext(employeeId, company_id);
  const policy = await _resolve(PayrollPolicy, company_id, unit_id || ctx.unit_id, ctx, "payroll");
  const full   = await PayrollPolicy.findById(policy._id).lean();

  if (!fresh) _cacheSet(key, full);
  return full;
};

const getCacheStats = () => {
  const now = Date.now();
  let active = 0, expired = 0;
  for (const [, entry] of _cache) {
    if (now > entry.expiresAt) expired++;
    else active++;
  }
  return { total: _cache.size, active, expired };
};


// ─────────────────────────────────────────────────────────────────────────────
// T-10 — resolveUnitConfig
// Returns merged config: Unit override + Company default fallback
// Used by: attendance.service, payrollRun.service
// ─────────────────────────────────────────────────────────────────────────────

const Unit          = require("../modules/unit/models/unit.model");
const CompanyConfig = require("../modules/companyConfig/models/companyConfig.model");

/**
 * Resolve operational config for a unit.
 * Unit override takes priority; falls back to CompanyConfig default.
 *
 * @param {string} unitId
 * @param {string} companyId
 * @param {string} orgId
 * @returns {object} merged config
 */
const resolveUnitConfig = async (unitId, companyId, orgId) => {
  const [unit, companyConfig] = await Promise.all([
    unitId
      ? Unit.findById(unitId).select("config_override").lean()
      : null,
    CompanyConfig.findOne({ company_id: companyId }).lean(),
  ]);

  const override = unit?.config_override || {};
  const defaults = companyConfig || {};

  return {
    // Tier 2 overridable fields
    working_days: override.working_days?.length
      ? override.working_days
      : defaults.workWeek || ["MON", "TUE", "WED", "THU", "FRI"],

    standard_hours_per_day: override.standard_hours_per_day
      ?? defaults.standardHoursPerDay
      ?? 8,

    regularisation_window_days: override.regularisation_window_days
      ?? defaults.regularisationWindowDays
      ?? 30,

    default_fallback_shift: override.default_fallback_shift
      ?? defaults.defaultFallbackShift
      ?? null,

    payroll_cutoff_day: override.payroll_cutoff_day
      ?? defaults.payrollCutoffDay
      ?? 25,

    salary_day: override.salary_day
      ?? defaults.salaryDay
      ?? 1,

    // Tier 1 — always from CompanyConfig
    timezone:         defaults.timezone    || "Asia/Kolkata",
    currency:         defaults.currency    || "INR",
    fiscal_year_start: defaults.fiscalYearStart || 4,
    overtime_threshold_hours: defaults.overtimeThresholdHours || 9,
    half_day_threshold_hours: defaults.halfDayThresholdHours  || 4,
  };
};

module.exports = {
  resolveLeavePolicy,
  resolveAttendancePolicy,
  resolvePayrollPolicy,
  invalidatePolicyCache,
  invalidateEmployeeCache,
  getCacheStats,
  resolveUnitConfig,
};