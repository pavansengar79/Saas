// modules/leavePolicy/leavePolicy.service.js
// UPDATED — tenantId → org_id + company_id + unit_id
// UPDATED — Policy Versioning: snapshot saved before every UPDATE / ACTIVATE /
//           DEACTIVATE / ARCHIVE / RESTORE. New exports: getVersionHistory,
//           getVersionSnapshot, restoreVersion.

const LeavePolicy  = require("./models/leavePolicy.model");
const LeaveType    = require("../leave/models/leaveType.models");
const LeaveBalance = require("../leave/models/leaveBalance.models");
const AppError     = require("../../utils/appError");
const { invalidatePolicyCache } = require("../../utils/policyResolver");
const policyVersionService = require("../policyVersion/policyVersion.service");
const { resolveLeaveTypeScope } = require("../leave/leaveTypeScope");
// seedLeaveBalances removed - balances calculated dynamically from active policy

const POLICY_TYPE = "LEAVE";

// ── Scope filter ──────────────────────────────────────────
const buildFilter = (user) => {
  const filter = { org_id: user.orgId };
  if (user.companyId) filter.company_id = user.companyId;
  if (user.unitId)    filter.unit_id    = user.unitId;
  return filter;
};

// ─── CREATE ───────────────────────────────────────────────
exports.createPolicy = async (body, user) => {
  const policy = await LeavePolicy.create({
    ...body,
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    user.unitId || null,
    version:    1,
    createdBy:  user.userId,
    updatedBy:  user.userId,
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

// ─── GET ALL ──────────────────────────────────────────────
exports.getPolicies = async (user, query = {}) => {
  const filter = { ...buildFilter(user) };
  if (query.status) filter.status = query.status;
  if (query.search) {
    filter.name = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }

  const page  = parseInt(query.page)  || 1;
  const limit = parseInt(query.limit) || 20;
  const skip  = (page - 1) * limit;

  const [policies, total] = await Promise.all([
    LeavePolicy.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("applicableFor.departments",  "name")
      .populate("applicableFor.designations", "name")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email"),
    LeavePolicy.countDocuments(filter),
  ]);

  return { policies, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
};

// ─── GET ONE ──────────────────────────────────────────────
exports.getPolicyById = async (id, user) => {
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) })
    .populate("applicableFor.departments",  "name")
    .populate("applicableFor.designations", "name")
    .populate("createdBy",   "name email")
    .populate("updatedBy",   "name email")
    .populate("activatedBy", "name email")
    .populate("archivedBy",  "name email")
    .populate("leaveTypes.leaveTypeId", "name code isPaid isSystem");

  if (!policy) throw new AppError("Leave policy not found", 404);
  return policy;
};

// ─── UPDATE ───────────────────────────────────────────────
exports.updatePolicy = async (id, body, user) => {
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Leave policy not found", 404);

  if (policy.status === "archived") {
    throw new AppError("Cannot update an archived policy. Create a new version instead.", 400);
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

  const { leaveTypes, changeNote, ...updateData } = body;

  Object.assign(policy, {
    ...updateData,
    version:   policy.version + 1,
    updatedBy: user.userId,
  });

  await policy.save();
  invalidatePolicyCache("leave", policy.company_id.toString());
  return policy;
};

// ─── GET AVAILABLE LEAVE TYPES ────────────────────────────
exports.getAvailableLeaveTypes = async (user, query = {}) => {
  const scope = await resolveLeaveTypeScope(user, query, true);
  return LeaveType.find({
    ...scope,
    isActive:   true,
    isDeleted:  false,
  }).select("_id name code isPaid isSystem description defaultDaysPerYear");
};

// ─── UPDATE LEAVE TYPES ───────────────────────────────────
exports.updateLeaveTypes = async (id, leaveTypes, user) => {
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Leave policy not found", 404);
  if (policy.status === "archived") throw new AppError("Cannot update an archived policy", 400);

  // Fetch master data using leaveTypeId
  const linkedIds = [...new Set(
    leaveTypes.filter((leaveType) => leaveType.leaveTypeId).map((leaveType) => leaveType.leaveTypeId.toString())
  )];
  const masterMap = {};

  if (linkedIds.length > 0) {
    const masters = await LeaveType.find({
      _id:        { $in: linkedIds },
      org_id:     policy.org_id,
      company_id: policy.company_id,
      isActive:   true,
      isDeleted:  false,
    }).select("name code isPaid defaultDaysPerYear");

    masters.forEach((m) => { masterMap[m._id.toString()] = m; });

    const invalidIds = linkedIds.filter((leaveTypeId) => !masterMap[leaveTypeId]);
    if (invalidIds.length > 0) {
      throw new AppError(`Invalid leaveTypeId(s): ${invalidIds.join(", ")}`, 400);
    }
  }

  // Auto-fill name, code, credit from master
  const normalizedTypes = leaveTypes.map((lt) => {
    if (!lt.leaveTypeId) return lt;

    const master = masterMap[lt.leaveTypeId.toString()];
    if (!master) return lt;

    return {
      ...lt,
      name:   lt.name   || master.name,
      code:   lt.code   || master.code,
      isPaid: lt.isPaid !== undefined ? lt.isPaid : master.isPaid,
      credit: lt.credit || {
        totalPerYear: lt.totalDaysPerYear || master.defaultDaysPerYear || 0,
        frequency:    "YEARLY",
      },
    };
  });

  // Duplicate code check
  const codes = normalizedTypes.filter((t) => t.code).map((t) => t.code.toUpperCase());
  if (codes.length !== new Set(codes).size) throw new AppError("Duplicate leave type codes found", 400);

  // ── Save snapshot BEFORE changing leaveTypes ───────────────────────────────
  await policyVersionService.saveVersionSnapshot({
    policyType: POLICY_TYPE,
    policyDocBeforeChange: policy,
    action: "UPDATE",
    user,
    changeNote: "Leave types updated",
    changedFields: ["leaveTypes"],
  });

  policy.leaveTypes = normalizedTypes;
  policy.version    = policy.version + 1;
  policy.updatedBy  = user.userId;
  await policy.save();
  invalidatePolicyCache("leave", policy.company_id.toString());
  return policy;
};

// ─── ACTIVATE ─────────────────────────────────────────────
exports.activatePolicy = async (id, user) => {
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Leave policy not found", 404);
  if (policy.status === "active")   throw new AppError("Policy is already active", 400);
  if (policy.status === "archived") throw new AppError("Cannot activate an archived policy", 400);
  if (!policy.leaveTypes?.length)   throw new AppError("Cannot activate policy with no leave types", 400);

  // Scope-conflict check — block activation if another already-active policy
  // covers any of the same departments (same reasoning as AttendancePolicy).
  const departments = policy.applicableFor?.departments || [];
  if (departments.length > 0) {
    const conflict = await LeavePolicy.findOne({
      _id:        { $ne: policy._id },
      company_id: policy.company_id,
      status:     "active",
      isDeleted:  false,
      "applicableFor.departments": { $in: departments },
    }).select("name").lean();

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

  policy.status      = "active";
  policy.activatedBy = user.userId;
  policy.activatedAt = new Date();
  policy.version     = policy.version + 1;
  policy.updatedBy   = user.userId;

  await policy.save();
  invalidatePolicyCache("leave", policy.company_id.toString());

  // NOTE: Balance seeding removed - balances are calculated dynamically from active policy
  // Employees will automatically have correct allocations based on policy.leaveTypes[].credit.totalPerYear

  return policy;
};

// ─── DEACTIVATE ───────────────────────────────────────────
exports.deactivatePolicy = async (id, user) => {
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Leave policy not found", 404);
  if (policy.status === "inactive") throw new AppError("Policy is already inactive", 400);
  if (policy.status === "archived") throw new AppError("Cannot deactivate an archived policy", 400);
  if (policy.status === "draft")    throw new AppError("Cannot deactivate a draft policy", 400);

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
  invalidatePolicyCache("leave", policy.company_id.toString());
  return policy;
};

// ─── ARCHIVE ──────────────────────────────────────────────
exports.archivePolicy = async (id, user) => {
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Leave policy not found", 404);
  if (policy.status === "archived") throw new AppError("Policy is already archived", 400);

  await policyVersionService.saveVersionSnapshot({
    policyType: POLICY_TYPE,
    policyDocBeforeChange: policy,
    action: "ARCHIVE",
    user,
    changeNote: "Policy archived",
  });

  policy.status     = "archived";
  policy.archivedBy = user.userId;
  policy.archivedAt = new Date();
  policy.updatedBy  = user.userId;
  policy.version    = policy.version + 1;

  await policy.save();
  invalidatePolicyCache("leave", policy.company_id.toString());
  return policy;
};

// ─── DELETE ───────────────────────────────────────────────
exports.deletePolicy = async (id, user) => {
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Leave policy not found", 404);

  if (policy.status === "active") {
    throw new AppError("Cannot delete an active policy. Archive it first.", 400);
  }

  const linkedTypeIds = policy.leaveTypes.filter((t) => t.leaveTypeId).map((t) => t.leaveTypeId);

  if (linkedTypeIds.length > 0) {
    const balanceCount = await LeaveBalance.countDocuments({
      company_id:  user.companyId,
      leaveTypeId: { $in: linkedTypeIds },
    });
    if (balanceCount > 0) {
      throw new AppError(
        `Cannot delete — ${balanceCount} leave balance record(s) exist for linked leave types. Archive instead.`,
        409
      );
    }
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
  // Ensure policy exists & user has access
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) }).select("_id name version");
  if (!policy) throw new AppError("Leave policy not found", 404);

  const history = await policyVersionService.getVersionHistory(POLICY_TYPE, id, user);

  return {
    policyId:      policy._id,
    policyName:    policy.name,
    currentVersion: policy.version,
    history,
  };
};

// ─── GET ONE VERSION SNAPSHOT ──────────────────────────────────────────────
exports.getVersionSnapshot = async (id, version, user) => {
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) }).select("_id name");
  if (!policy) throw new AppError("Leave policy not found", 404);

  return await policyVersionService.getVersionSnapshot(POLICY_TYPE, id, version, user);
};

// ─── RESTORE A PREVIOUS VERSION ────────────────────────────────────────────
// Restoring NEVER overwrites status/audit fields (status, activatedBy/At,
// archivedBy/At, isDeleted) — only the "config" portion of the policy is
// rolled back. The policy keeps its current lifecycle status.
exports.restoreVersion = async (id, version, user) => {
  const policy = await LeavePolicy.findOne({ _id: id, ...buildFilter(user) });
  if (!policy) throw new AppError("Leave policy not found", 404);
  if (policy.status === "archived") {
    throw new AppError("Cannot restore an archived policy. Activate or unarchive first.", 400);
  }

  const snapshot = await policyVersionService.prepareRestore(POLICY_TYPE, id, version, user);

  // Save current state as a new version entry BEFORE restoring
  await policyVersionService.saveVersionSnapshot({
    policyType: POLICY_TYPE,
    policyDocBeforeChange: policy,
    action: "RESTORE",
    user,
    changeNote: `Restored from version ${version}`,
  });

  // Fields that must NOT be touched by restore (lifecycle/audit/identity)
  const PROTECTED_FIELDS = new Set([
    "_id", "org_id", "company_id", "unit_id",
    "status", "isDeleted",
    "activatedBy", "activatedAt", "archivedBy", "archivedAt",
    "createdBy", "createdAt", "updatedAt", "version",
    // Mongoose virtuals — not real fields
    "isActive", "totalLeaveTypesCount", "activeLeaveTypes", "id",
  ]);

  // Get all config field names from the live policy (includes fields not in snapshot)
  const allConfigFields = Object.keys(policy.toObject())
    .filter(k => !PROTECTED_FIELDS.has(k));

  // Apply snapshot values — if snapshot doesn't have a field, set it to null/undefined
  // This handles cases like description being added after v1 and needing to be cleared
  for (const key of allConfigFields) {
    if (!PROTECTED_FIELDS.has(key)) {
      policy[key] = key in snapshot ? snapshot[key] : null;
    }
  }

  policy.version   = policy.version + 1;
  policy.updatedBy = user.userId;

  await policy.save();
  invalidatePolicyCache("leave", policy.company_id.toString());
  return policy;
};