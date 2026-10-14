// modules/role/role.service.js
// UPDATED — tenantId → org_id scope
//
// Permission Downward Scope Rule:
//   Org Admin    → can assign permissions with scope: org, company, unit
//   Company Admin → can assign permissions with scope: company, unit
//   Unit Admin   → can assign permissions with scope: unit only
//
// Role level rule:
//   Org Admin    → creates level:"org" roles
//   Company Admin → creates level:"company" roles
//   Unit Admin   → creates level:"unit" roles

const Role       = require("./role.model");
const Permission = require("../permission/permission.model");
const User       = require("../auth/models/user.model");
const AppError   = require("../../utils/appError");
const { slugifyRoleName, SLUG_MAX_LENGTH } = require("../../utils/roleSlug");

// ─── Allowed scopes per user level ───────────────────────────
const ALLOWED_SCOPES = {
  org:     ["org", "company", "unit"],
  company: ["company", "unit"],
  unit:    ["unit"],
};

const buildHolderScopeFilter = (user) => {
  if (user.role === "SUPER_ADMIN") return {};

  const filter = { org_id: user.orgId };

  if (user.level === "company") {
    filter.company_id = user.companyId;
  } else if (user.level === "unit") {
    filter.company_id = user.companyId;
    filter.unit_id = user.unitId;
  }

  return filter;
};

// ─── Validate permissions against user level ──────────────────
const validatePermissionScope = (permDocs, userLevel) => {
  if (!userLevel || userLevel === "SUPER_ADMIN") return; // Super Admin — no restriction

  const allowedScopes = ALLOWED_SCOPES[userLevel] || [];

  for (const perm of permDocs) {
    const permScope = perm.scope || [];

    // Check karo — kya is permission ka koi scope user ke allowed scopes mein hai
    const canAssign = permScope.some(s => allowedScopes.includes(s));

    if (!canAssign) {
      throw new AppError(
        `You cannot assign permission "${perm.slug}" — it is above your access level (${userLevel})`,
        403
      );
    }
  }
};

// ─── SLUG RESOLUTION ──────────────────────────────────────────
// Builds a valid slug from the name (or a client-sent slug) and makes it
// unique. A custom role must never reuse a system role's slug: access checks
// across the app compare the slug ("org_admin", "hr_manager", ...), so a
// custom "org_admin" would silently get admin privileges.
// Deleted roles are included because the unique index (slug+org_id+level)
// still covers them.
const resolveUniqueRoleSlug = async (source, orgId, level) => {
  const base = slugifyRoleName(source);
  if (!base) throw new AppError("Role name must contain at least one letter or number", 400);

  const [systemSlugs, orgSlugs] = await Promise.all([
    Role.distinct("slug", { $or: [{ isSystem: true }, { org_id: null }] }),
    Role.distinct("slug", {
      org_id: orgId || null,
      level,
      slug:   { $regex: `^${base}(_\\d+)?$` },
    }),
  ]);
  const taken = new Set([...systemSlugs, ...orgSlugs]);

  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const candidate = `${base.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new AppError("Could not generate a unique identifier for this role", 409);
};

// ─── CREATE ROLE ──────────────────────────────────────────────
exports.createRole = async (payload, user) => {
  const { name, slug, description, permissions, level } = payload;

  // Level must match user's level (cannot create higher level role)
  const roleLevel = level || user.level;

  if (user.role !== "SUPER_ADMIN") {
    const allowedLevels = ALLOWED_SCOPES[user.level]?.includes(roleLevel);
    if (!allowedLevels) {
      throw new AppError(
        `You can only create roles at your level or below (${user.level})`,
        403
      );
    }
  }

  // Duplicate name check — same org (case-insensitive)
  const escapedName = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sameName = await Role.findOne({
    name:      { $regex: `^${escapedName}$`, $options: "i" },
    org_id:    user.orgId,
    isDeleted: false,
  }).select("_id").lean();
  if (sameName) throw new AppError("A role with this name already exists", 409);

  const finalSlug = await resolveUniqueRoleSlug(slug || name, user.orgId, roleLevel);

  // Validate permissions exist
  const permDocs = await Permission.find({
    _id:       { $in: permissions },
    is_active: true,
  });

  if (permDocs.length !== permissions.length) {
    throw new AppError("One or more permissions are invalid or inactive", 400);
  }

  // ── Downward scope validation ─────────────────────────────
  // User can only assign permissions at their level or below
  validatePermissionScope(permDocs, user.level);

  const role = await Role.create({
    name,
    slug:       finalSlug,
    description,
    permissions,
    level:      roleLevel,
    org_id:     user.orgId,
    company_id: user.companyId || null,
    unit_id:    user.unitId    || null,
    isSystem:   false,
    createdBy:  user.userId,
  });

  return await Role.findById(role._id).populate("permissions", "name slug module scope");
};

// ─── GET ALL ROLES ────────────────────────────────────────────
// exports.getRoles = async (user) => {
//   if (user.role === "SUPER_ADMIN") {
//     return await Role.find({ isDeleted: false })
//       .populate("permissions", "name slug module scope");
//   }

//   return await Role.find({
//     isDeleted: false,
//     $or: [
//       { org_id: user.orgId },          // org ke custom roles
//       { org_id: null, isSystem: true } // system roles
//     ]
//   }).populate("permissions", "name slug module scope");
// };
exports.getRoles = async (user) => {
  const holderScopeFilter = buildHolderScopeFilter(user);

  if (user.role === "SUPER_ADMIN") {
    const roles = await Role.find({ isDeleted: false })
      .populate("permissions", "name slug module scope").lean();
    // T-05 — holder count
    for (const r of roles) {
      r.holderCount = await User.countDocuments({
        roleId: r._id,
        is_deleted: false,
        ...holderScopeFilter,
      });
    }
    return roles;
  }

  // Level hierarchy — org admin sees org+company+unit roles
  // company admin sees company+unit roles, unit admin sees unit roles
  const LEVEL_HIERARCHY = {
    org:     ["org", "company", "unit"],
    company: ["company", "unit"],
    unit:    ["unit"],
  };
  const allowedLevels = LEVEL_HIERARCHY[user.level] || [user.level];

  const query = {
    isDeleted: false,
    level:     { $in: allowedLevels },
    $or: [
      { org_id: user.orgId },          // org ke custom roles
      { org_id: null, isSystem: true } // system roles
    ]
  };

  const roles = await Role.find(query)
    .populate("permissions", "name slug module scope").lean();
  // T-05 — holder count
  for (const r of roles) {
    r.holderCount = await User.countDocuments({
      roleId: r._id,
      is_deleted: false,
      ...holderScopeFilter,
    });
  }
  return roles;
};
// ─── GET ONE ──────────────────────────────────────────────────
exports.getRoleById = async (roleId, user) => {
  const filter = {
    _id:       roleId,
    isDeleted: false,
    ...(user.role !== "SUPER_ADMIN" && {
      $or: [
        { org_id: user.orgId },
        { org_id: null, isSystem: true }
      ]
    })
  };

  const role = await Role.findOne(filter)
    .populate("permissions", "name slug module scope");
  if (!role) throw new AppError("Role not found", 404);
  return role;
};

// ─── UPDATE ROLE ──────────────────────────────────────────────
exports.updateRole = async (roleId, data, user) => {
  const filter = {
    _id:       roleId,
    isDeleted: false,
    ...(user.role !== "SUPER_ADMIN" && {
      $or: [
        { org_id: user.orgId },
        { org_id: null, isSystem: true }
      ]
    })
  };

  const role = await Role.findOne(filter);
  if (!role) throw new AppError("Role not found", 404);

  // System roles cannot be edited by customers
  if (role.isSystem && user.role !== "SUPER_ADMIN") {
    throw new AppError("System role cannot be updated", 403);
  }

  // Cannot change these fields
  delete data.org_id;
  delete data.isSystem;
  delete data.level;
  // Slug is the role's internal identifier — it goes into the JWT and is
  // used for access checks across the app, so it never changes after create.
  delete data.slug;

  // If permissions being updated — validate scope
  if (data.permissions && data.permissions.length > 0) {
    const permDocs = await Permission.find({
      _id:       { $in: data.permissions },
      is_active: true,
    });

    if (permDocs.length !== data.permissions.length) {
      throw new AppError("One or more permissions are invalid or inactive", 400);
    }

    // Downward scope check
    validatePermissionScope(permDocs, user.level);
  }

  Object.assign(role, data);
  role.updatedBy = user.userId;
  await role.save();

  return await Role.findById(role._id)
    .populate("permissions", "name slug module scope");
};

// ─── DELETE ROLE ──────────────────────────────────────────────
exports.deleteRole = async (roleId, user) => {
  // Check system roles first (without org filter so they can be found)
  const roleCheck = await Role.findOne({ _id: roleId, isDeleted: false });
  if (!roleCheck) throw new AppError("Role not found", 404);
  if (roleCheck.isSystem) throw new AppError("Cannot delete system role — system roles are protected", 403);

  const role = await Role.findOne({
    _id:       roleId,
    isDeleted: false,
    ...(user.role !== "SUPER_ADMIN" && { org_id: user.orgId })
  });
  if (!role) throw new AppError("Role not found or access denied", 404);

  const usersWithRole = await User.countDocuments({ roleId });
  if (usersWithRole > 0) {
    throw new AppError(
      `Cannot delete — ${usersWithRole} user(s) are assigned this role. Reassign them first.`,
      400
    );
  }

  role.isDeleted = true;
  await role.save();
  return { message: "Role deleted successfully" };
};

// ─── GET AVAILABLE PERMISSIONS ────────────────────────────────
// Frontend use karega — role create/edit form mein permissions dropdown
// Returns only permissions that user is allowed to assign
exports.getAssignablePermissions = async (user) => {
  if (user.role === "SUPER_ADMIN") {
    return await Permission.find({ is_active: true })
      .select("name slug module scope label")
      .sort({ module: 1, name: 1 });
  }

  const allowedScopes = ALLOWED_SCOPES[user.level] || [];

  // Sirf wahi permissions jo user assign kar sakta hai
  return await Permission.find({
    is_active: true,
    scope:     { $in: allowedScopes },
  })
    .select("name slug module scope label")
    .sort({ module: 1, name: 1 });
};

// ─────────────────────────────────────────────────────────────────────────────
// T-03 — Update Role Module Access
// PUT /api/v1/roles/:id/modules
// body: { modules: ["hrms", "crm", "sales", "bd", "admin"] }
// ─────────────────────────────────────────────────────────────────────────────
exports.updateRoleModules = async (roleId, body, user) => {
  const { modules } = body;

  if (!Array.isArray(modules)) {
    throw new AppError("modules must be an array", 400);
  }

  const VALID_MODULES = ["hrms", "crm", "sales", "bd", "admin", "organisation",
                          "employee", "attendance", "leave", "payroll", "auth"];

  const invalid = modules.filter(m => !VALID_MODULES.includes(m));
  if (invalid.length) {
    throw new AppError(`Invalid modules: ${invalid.join(", ")}`, 400);
  }

  const role = await Role.findOne({
    _id:       roleId,
    isDeleted: false,
    ...(user.role !== "SUPER_ADMIN" && { org_id: user.orgId }),
  });
  if (!role) throw new AppError("Role not found", 404);

  role.modules   = modules;
  role.updatedBy = user.userId;
  await role.save();

  return role;
};