// modules/attendancePolicy/attendancePolicy.service.js
// UPDATED — Policy Versioning: snapshot saved before every UPDATE / ACTIVATE /
//           DEACTIVATE / ARCHIVE / RESTORE. New exports: getVersionHistory,
//           getVersionSnapshot, restoreVersion.
// UPDATED — applicableFor.designations populate added.

const AttendancePolicy = require("./models/attendancePolicy.model");
const AppError          = require("../../utils/appError");
const { invalidatePolicyCache } = require("../../utils/policyResolver");
const { resolveIsNextDay } = require("../../utils/timezone");
const policyVersionService = require("../policyVersion/policyVersion.service");

const POLICY_TYPE = "ATTENDANCE";

// ─── Scope filter — Unit Level Isolation ───────────────────────────────────────
// Enterprise HRMS: strict unit-level data isolation for policies
// - SUPER_ADMIN sees all
// - Org Admin sees all in org
// - Company Admin sees all in company
// - Unit Admin sees ONLY their unit's policies (unit_id: user.unitId)
const buildFilter = (user) => {
  if (user.role === "SUPER_ADMIN") return {};
  
  const filter = { org_id: user.orgId };
  
  if (user.companyId) filter.company_id = user.companyId;
  if (user.unitId) filter.unit_id = user.unitId;
  
  return filter;
};

// ─── Create Policy ────────────────────────────────────────────────────────────
exports.createPolicy = async (body, user) => {

  // ── Guard 1: same name (case-insensitive) already exists for this tenant ───
  const nameExists = await AttendancePolicy.findOne({
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    user.unitId || null,
    name:      { $regex: new RegExp(`^${body.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
    isDeleted: false,
  });
  if (nameExists) {
    throw new AppError(
      `Attendance policy with name "${body.name}" already exists. Use a different name.`,
      409
    );
  }

  // ── Guard 2: same shift (start+end) + same applicableFor scope already exists
  // Regardless of status — even two drafts with identical shift+scope is meaningless
  const shiftAndScopeFilter = {
    org_id:            user.orgId,
    company_id:        user.companyId,
    isDeleted:         false,
    "shift.start":     body.shift.start,
    "shift.end":       body.shift.end,
  };

  if (body.applicableFor) {
    const { departments = [], designations = [], roles = [], locations = [], employmentTypes = [] } = body.applicableFor;
    if (departments.length)     shiftAndScopeFilter["applicableFor.departments"]     = { $all: departments, $size: departments.length };
    if (designations.length)    shiftAndScopeFilter["applicableFor.designations"]    = { $all: designations, $size: designations.length };
    if (roles.length)           shiftAndScopeFilter["applicableFor.roles"]           = { $all: roles,       $size: roles.length };
    if (locations.length)       shiftAndScopeFilter["applicableFor.locations"]       = { $all: locations,   $size: locations.length };
    if (employmentTypes.length) shiftAndScopeFilter["applicableFor.employmentTypes"] = { $all: employmentTypes, $size: employmentTypes.length };
  }

  const scopeConflict = await AttendancePolicy.findOne(shiftAndScopeFilter);
  if (scopeConflict) {
    throw new AppError(
      `A policy "${scopeConflict.name}" with the same shift timings and scope already exists (status: ${scopeConflict.status}).`,
      409
    );
  }

  // ── Guard 3: Validate shift_id reference if provided ───
  if (body.shift_id) {
    const Shift = require('../shift/models/shift.model')
    const shift = await Shift.findById(body.shift_id)
    if (!shift) {
      throw new AppError('Referenced shift not found', 404)
    }
    if (shift.unit_id.toString() !== (user.unitId || body.unit_id || shift.unit_id).toString()) {
      throw new AppError('Shift must belong to the same unit', 400)
    }
    // Auto-populate embedded shift from shift reference
    body.shift = {
      name: shift.name,
      start: shift.startTime,
      end: shift.endTime,
      isNextDay: resolveIsNextDay(shift.startTime, shift.endTime, shift.isNextDay), // AT-04
      graceMinutes: shift.gracePeriodMinutes,
      minimumHours: Math.floor(shift.workingMinutes / 60),
      halfDayMinHours: Math.floor(shift.halfDayThresholdMinutes / 60),
      strictPunchWindow: body.shift?.strictPunchWindow ?? true,
      allowLatePunchIn: body.shift?.allowLatePunchIn ?? false,
      maxLateMinutes: body.shift?.maxLateMinutes ?? 120,
      allowEarlyMinutes: body.shift?.allowEarlyMinutes ?? 30
    }
  }

  const policy = await AttendancePolicy.create({
    ...body,
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    user.unitId || null,
    version:   1,
    createdBy: user.userId,
    updatedBy: user.userId,
  });

  // Version 1 snapshot — captures the initial state
  await policyVersionService.saveVersionSnapshot({
    policyType: POLICY_TYPE,
    policyDocBeforeChange: policy,
    action: "CREATE",
    user,
    changeNote: "Policy created",
  });

  return policy;
};

// ─── Get All Policies ─────────────────────────────────────────────────────────
exports.getPolicies = async (user, query = {}) => {
  // Enterprise: Use strict scope filter
  const filter = { ...buildFilter(user) };

  if (query.status) filter.status = query.status;

  if (query.search) {
    filter.name = {
      $regex:   query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i",
    };
  }

  const page  = parseInt(query.page)  || 1;
  const limit = parseInt(query.limit) || 20;
  const skip  = (page - 1) * limit;

  const [policies, total] = await Promise.all([
    AttendancePolicy.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("applicableFor.departments",  "name")
      .populate("applicableFor.designations", "name")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email"),
    AttendancePolicy.countDocuments(filter),
  ]);

  return {
    policies,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  };
};

// ─── Get Policy By ID ─────────────────────────────────────────────────────────
exports.getPolicyById = async (id, user) => {
  // Enterprise: Use strict scope filter
  const policy = await AttendancePolicy.findOne({
    _id: id,
    ...buildFilter(user)
  })
    .populate("applicableFor.departments",  "name")
    .populate("applicableFor.designations", "name")
    .populate("shift_id")  // Populate shift reference for edit form
    .populate("createdBy", "name email")
    .populate("updatedBy", "name email");

  if (!policy) throw new AppError("Attendance policy not found", 404);
  return policy;
};

// ─── Update Policy ────────────────────────────────────────────────────────────
exports.updatePolicy = async (id, body, user) => {
  // Enterprise: Use strict scope filter
  const policy = await AttendancePolicy.findOne({
    _id: id,
    ...buildFilter(user)
  });
  
  if (!policy) throw new AppError("Attendance policy not found", 404);

  if (policy.status === "archived") {
    throw new AppError(
      "Cannot update an archived policy. Create a new one instead.",
      400
    );
  }

  // ── Save snapshot of CURRENT state BEFORE applying changes ────────────────
  await policyVersionService.saveVersionSnapshot({
    policyType: POLICY_TYPE,
    policyDocBeforeChange: policy,
    action: "UPDATE",
    user,
    changeNote: body.changeNote || "Policy updated",
    incomingChanges: body,
  });

  // Deep-merge nested objects so partial updates work correctly
  // e.g. PUT with only { lateMark: { enabled: false } } must not wipe other lateMark fields
  const mergeNested = (existing, incoming) => {
    if (!incoming || typeof incoming !== "object") return existing;
    return { ...existing.toObject?.() ?? existing, ...incoming };
  };

  // ── If shift_id is provided, auto-populate embedded shift ───
  if (body.shift_id !== undefined) {
    if (body.shift_id) {
      const Shift = require('../shift/models/shift.model')
      const shift = await Shift.findById(body.shift_id)
      if (!shift) {
        throw new AppError('Referenced shift not found', 404)
      }
      if (shift.unit_id.toString() !== policy.unit_id.toString()) {
        throw new AppError('Shift must belong to the same unit', 400)
      }
      policy.shift_id = body.shift_id
      body.shift = {
        name: shift.name,
        start: shift.startTime,
        end: shift.endTime,
        isNextDay: resolveIsNextDay(shift.startTime, shift.endTime, shift.isNextDay), // AT-04
        graceMinutes: shift.gracePeriodMinutes,
        minimumHours: Math.floor(shift.workingMinutes / 60),
        halfDayMinHours: Math.floor(shift.halfDayThresholdMinutes / 60),
        strictPunchWindow: body.shift?.strictPunchWindow ?? policy.shift?.strictPunchWindow ?? true,
        allowLatePunchIn: body.shift?.allowLatePunchIn ?? policy.shift?.allowLatePunchIn ?? false,
        maxLateMinutes: body.shift?.maxLateMinutes ?? policy.shift?.maxLateMinutes ?? 120,
        allowEarlyMinutes: body.shift?.allowEarlyMinutes ?? policy.shift?.allowEarlyMinutes ?? 30
      }
    } else {
      policy.shift_id = null
    }
  }
  
  // Handle embedded shift if provided (auto-populated from shift_id or manual)
  if (body.shift !== undefined) {
    policy.shift = mergeNested(policy.shift, body.shift);
  }

  if (body.shift)        policy.shift        = mergeNested(policy.shift, body.shift);
  if (body.lateMark)     policy.lateMark     = mergeNested(policy.lateMark, body.lateMark);
  if (body.sandwichRule) policy.sandwichRule = mergeNested(policy.sandwichRule, body.sandwichRule);
  if (body.overtime)     policy.overtime     = mergeNested(policy.overtime, body.overtime);

  // Scalar / top-level fields
  if (body.name          !== undefined) policy.name          = body.name;
  if (body.description   !== undefined) policy.description   = body.description;
  if (body.applicableFor !== undefined) policy.applicableFor = body.applicableFor;

  policy.version   = policy.version + 1;
  policy.updatedBy = user.userId;

  await policy.save();
  invalidatePolicyCache("attendance", user.companyId.toString());
  return policy;
};
// ─── Activate Policy ──────────────────────────────────────────────────────────
exports.activatePolicy = async (id, user) => {
  // Enterprise: Use strict scope filter
  const policy = await AttendancePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Attendance policy not found", 404);
  if (policy.status === "active")   throw new AppError("Policy is already active", 400);
  if (policy.status === "archived") throw new AppError("Cannot activate an archived policy", 400);

  // Scope-conflict check — block activation if another already-active policy
  // covers any of the same departments. Without this, two active policies
  // can silently overlap and policyResolver picks whichever was activated
  // most recently, with no warning to HR that the "active" one they see in
  // the list isn't actually the one being applied.
  const departments = policy.applicableFor?.departments || [];
  if (departments.length > 0) {
    const conflict = await AttendancePolicy.findOne({
      _id:        { $ne: policy._id },
      company_id: policy.company_id,
      status:     "active",
      isDeleted:  false,
      "applicableFor.departments": { $in: departments },
    }).select("name applicableFor.departments").lean();

    if (conflict) {
      throw new AppError(
        `Cannot activate — "${conflict.name}" is already active for one or more of the same departments. Deactivate it first, or remove the overlapping department(s) from this policy.`,
        409
      );
    }
  }

  await policyVersionService.saveVersionSnapshot({
    policyType: POLICY_TYPE,
    policyDocBeforeChange: policy,
    action: "ACTIVATE",
    user,
    changeNote: "Policy activated",
  });

  policy.status    = "active";
  policy.version   = policy.version + 1;
  policy.updatedBy = user.userId;

  await policy.save();
  invalidatePolicyCache("attendance", user.companyId.toString());
  return policy;
};

// ─── Deactivate Policy ────────────────────────────────────────────────────────
exports.deactivatePolicy = async (id, user) => {
  // Enterprise: Use strict scope filter
  const policy = await AttendancePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Attendance policy not found", 404);
  if (policy.status === "inactive") throw new AppError("Policy is already inactive", 400);
  if (policy.status === "archived") throw new AppError("Cannot deactivate an archived policy", 400);
  if (policy.status === "draft")    throw new AppError("Cannot deactivate a draft — delete it instead", 400);

  await policyVersionService.saveVersionSnapshot({
    policyType: POLICY_TYPE,
    policyDocBeforeChange: policy,
    action: "DEACTIVATE",
    user,
    changeNote: "Policy deactivated",
  });

  policy.status    = "inactive";
  policy.version   = policy.version + 1;
  policy.updatedBy = user.userId;

  await policy.save();
  invalidatePolicyCache("attendance", user.companyId.toString());
  return policy;
};

// ─── Archive Policy ───────────────────────────────────────────────────────────
exports.archivePolicy = async (id, user) => {
  // Enterprise: Use strict scope filter
  const policy = await AttendancePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Attendance policy not found", 404);
  if (policy.status === "archived") throw new AppError("Policy is already archived", 400);

  await policyVersionService.saveVersionSnapshot({
    policyType: POLICY_TYPE,
    policyDocBeforeChange: policy,
    action: "ARCHIVE",
    user,
    changeNote: "Policy archived",
  });

  policy.status    = "archived";
  policy.version   = policy.version + 1;
  policy.updatedBy = user.userId;

  await policy.save();
  invalidatePolicyCache("attendance", user.companyId.toString());
  return policy;
};

// ─── Delete Policy ────────────────────────────────────────────────────────────
exports.deletePolicy = async (id, user) => {
  // Enterprise: Use strict scope filter
  const policy = await AttendancePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Attendance policy not found", 404);
  if (policy.status === "active") {
    throw new AppError("Cannot delete an active policy. Archive it first.", 400);
  }

  policy.isDeleted = true;
  policy.updatedBy = user.userId;
  await policy.save();

  return { message: "Policy deleted successfully" };
};

// ═══════════════════════════════════════════════════════════════════════════
// ─── VERSIONING ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET VERSION HISTORY ──────────────────────────────────────────────────
exports.getVersionHistory = async (id, user) => {
  // Enterprise: Use strict scope filter
  const policy = await AttendancePolicy.findOne({ _id: id, ...buildFilter(user) }).select("_id name version");
  if (!policy) throw new AppError("Attendance policy not found", 404);

  const history = await policyVersionService.getVersionHistory(POLICY_TYPE, id, user);

  return {
    policyId:       policy._id,
    policyName:     policy.name,
    currentVersion: policy.version,
    history,
  };
};

// ─── GET ONE VERSION SNAPSHOT ──────────────────────────────────────────────
exports.getVersionSnapshot = async (id, version, user) => {
  const policy = await AttendancePolicy.findOne({ _id: id, ...buildFilter(user) }).select("_id name");
  if (!policy) throw new AppError("Attendance policy not found", 404);

  return await policyVersionService.getVersionSnapshot(POLICY_TYPE, id, version, user);
};

// ─── RESTORE A PREVIOUS VERSION ────────────────────────────────────────────
exports.restoreVersion = async (id, version, user) => {
  // Enterprise: Use strict scope filter
  const policy = await AttendancePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Attendance policy not found", 404);
  if (policy.status === "archived") {
    throw new AppError("Cannot restore an archived policy. Activate or unarchive first.", 400);
  }

  const snapshot = await policyVersionService.prepareRestore(POLICY_TYPE, id, version, user);

  await policyVersionService.saveVersionSnapshot({
    policyType: POLICY_TYPE,
    policyDocBeforeChange: policy,
    action: "RESTORE",
    user,
    changeNote: `Restored from version ${version}`,
  });

 const PROTECTED_FIELDS = new Set([
  "_id", "org_id", "company_id", "unit_id",
  "status", "isDeleted",
  "activatedBy", "activatedAt", "archivedBy", "archivedAt",
  "createdBy", "createdAt", "updatedAt", "version",
  "isActive", "id",
]);

const allConfigFields = Object.keys(policy.toObject())
  .filter(k => !PROTECTED_FIELDS.has(k));

for (const key of allConfigFields) {
  if (!PROTECTED_FIELDS.has(key)) {
    policy[key] = key in snapshot ? snapshot[key] : null;
  }
}

  policy.version   = policy.version + 1;
  policy.updatedBy = user.userId;

  await policy.save();
  invalidatePolicyCache("attendance", user.companyId.toString());
  return policy;
};
