const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const User = require("../auth/models/user.model");
const Employee = require("../employee/models/employee.model");
const UserProgression = require("./models/userProgression.model");
const Role = require("../role/role.model");
const Department = require("../department/department.model");
const Designation = require("../designation/designation.model");
const Company = require("../company/models/company.model");
const Unit = require("../unit/models/unit.model");
const Joi = require("joi");
const mongoose = require("mongoose");

const AppError = require("../../utils/appError");
const Subscription = require("../subscription/models/subscription.Models"); // T-27
const { sendEmail } = require("../../utils/email/email");
const inviteTemplate = require("../../utils/email/templates/inviteEmail");

const { invalidateEmployeeCache } = require("../../utils/policyResolver");
const { assertPlanAllowsCompanyRoles } = require("../../utils/companyRoleEntitlement");

// ── Scope filter ──────────────────────────────────────────
const buildScopeFilter = (user) => {
  if (user.role === "SUPER_ADMIN") return {};

  const filter = { org_id: user.orgId };

  if (user.level === "company") {
    filter.company_id = user.companyId;
  } else if (user.level === "unit") {
    filter.company_id = user.companyId;
    filter.unit_id    = user.unitId;
  }
  // Org level → filter only by org_id to include all users in the org

  return filter;
};

const getAccessibleRoleLevels = (userLevel) => {
  if (userLevel === "org") return ["org", "company"];
  if (userLevel === "company") return ["company", "unit"];
  return [userLevel];
};

// ─────────────────────────────────────────────────────────────
// INVITE USER
// POST /users/invite
// ─────────────────────────────────────────────────────────────
exports.inviteUser = async (data, currentUser) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  let user, role, department, company, tempPassword;

  try {
    const { email, roleId, departmentId, company_id, unit_id, name } = data;

    const existingUser = await User.findOne({
      email,
      org_id: currentUser.orgId,
      is_deleted: false,
    }).session(session);

    if (existingUser) {
      throw new AppError("This email is already registered", 409);
    }

    role = await Role.findOne({
      _id: roleId,
      $or: [
        { org_id: currentUser.orgId },
        { org_id: null, isSystem: true },
      ],
    }).select("name slug level").session(session);

    if (!role) {
      throw new AppError("Role not found or not accessible", 404);
    }

    const hierarchy = { org: 3, company: 2, unit: 1 };
    const currentLevel = hierarchy[currentUser.level] || 0;
    const targetLevel = hierarchy[role.level] || 0;

    if (targetLevel > currentLevel) {
      throw new AppError(`You cannot assign ${role.level} level role`, 403);
    }

    const resolvedCompanyId = company_id || currentUser.companyId || null;
    if (role.level === "company") {
      await assertPlanAllowsCompanyRoles(currentUser.orgId, session);
      if (!resolvedCompanyId) {
        throw new AppError("A company is required for a company-level role", 400);
      }
      if (currentUser.level === "company" && String(resolvedCompanyId) !== String(currentUser.companyId)) {
        throw new AppError("You cannot invite users to another company", 403);
      }
      const targetCompany = await Company.findOne({
        _id: resolvedCompanyId,
        org_id: currentUser.orgId,
        is_deleted: false,
      }).select("_id").session(session);
      if (!targetCompany) {
        throw new AppError("Company not found in your organization", 404);
      }
    }

    let resolvedDepartmentId = null;

    if (role.slug === "employee") {
      if (!departmentId) {
        throw new AppError("Department is required for employee role", 400);
      }
      const dept = await Department.findOne({
        _id: departmentId,
        company_id: currentUser.companyId,
        isDeleted: false,
      }).session(session);

      if (!dept) throw new AppError("Invalid department", 404);
      resolvedDepartmentId = dept._id;
    }

    const subscription = await Subscription.findOne({
      org_id: currentUser.orgId,
      is_active: true,
    }).select("plan_snapshot.seat_limit").session(session).lean();

       const seatLimit = subscription?.plan_snapshot?.seat_limit;
    if (seatLimit !== null && seatLimit !== undefined) {
      // INACTIVE users still hold their seat (reserved) — only users whose
      // linked Employee record is TERMINATED free up the seat. Matches
      // createEmployee's rule so both counts stay consistent.
      const terminatedUserIds = await Employee.find({
        org_id: currentUser.orgId,
        status: "TERMINATED",
        userId: { $ne: null },
      }).distinct("userId").session(session);

      const currentUserCount = await User.countDocuments({
        org_id:     currentUser.orgId,
        is_deleted: false,
        _id:        { $nin: terminatedUserIds },
      }).session(session);

      if (currentUserCount >= seatLimit) {
        throw new AppError(
          `Seat limit reached (${seatLimit}). Please upgrade your plan to invite more users.`,
          403
        );
      }
    }

    tempPassword = crypto.randomBytes(4).toString("hex");
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    const createdUsers = await User.create([{
      name: name || email.split("@")[0],
      email,
      password: hashedPassword,
      roleId,
      org_id: currentUser.orgId,
      company_id: resolvedCompanyId,
      unit_id: unit_id || currentUser.unitId || null,
      status: "ACTIVE",
      is_first_login: true,
      isEmailVerified: true,
      createdBy: currentUser.userId,
    }], { session });

    user = createdUsers[0];

    // Keep the existing primary admin when another company admin is invited.
    // Inviting a different company-level role must not replace that reference.
    if (role.slug === "company_admin" && resolvedCompanyId) {
      await Company.updateOne(
        { _id: resolvedCompanyId, org_id: currentUser.orgId, is_deleted: false, admin: null },
        { $set: { admin: user._id } },
        { session }
      );
    }

    // ─────────────────────────────────────────────────────────────
    // CREATE EMPLOYEE RECORD FOR USER (HRMS STANDARD)
    // Every user (including admins) needs an Employee record for:
    // - Attendance (punch in/out)
    // - Leave management
    // - Payroll
    // - Analytics/headcount
    // ─────────────────────────────────────────────────────────────
    
    // Determine unit_id for employee
    // Priority: 1) Passed in request body, 2) Role level is 'unit' → use currentUser's unit
    let employeeUnitId = unit_id;
    if (!employeeUnitId && role.level === 'unit') {
      employeeUnitId = currentUser.unitId;
    }
    // If still no unit_id but role needs unit (like unit_admin), use the unit_id from user we just created
    if (!employeeUnitId && user.unit_id) {
      employeeUnitId = user.unit_id;
    }
    
    // For unit-level roles, we MUST have a unit_id
    if (role.level === 'unit' && !employeeUnitId) {
      employeeUnitId = currentUser.unitId || user.unit_id;
    }
    
    // Determine company_id
    const employeeCompanyId = user.company_id || currentUser.companyId;
    
    // Only create Employee if we have all required fields
    if (employeeUnitId && employeeCompanyId && user.org_id) {
      // Find or create department for the user
      let empDepartmentId = resolvedDepartmentId;
      
      if (!empDepartmentId) {
        // For admin roles, create/find "Administration" department
        let adminDept = await Department.findOne({
          company_id: employeeCompanyId,
          org_id: user.org_id,
          unit_id: employeeUnitId,
          name: { $regex: /^(Administration|Admin|HR)$/i },
          isDeleted: false,
        }).session(session);
        
        if (!adminDept) {
          const [createdDept] = await Department.create([{
            name: 'Administration',
            company_id: employeeCompanyId,
            org_id: user.org_id,
            unit_id: employeeUnitId,
            status: 'active',
            created_by: currentUser.userId,
          }], { session });
          adminDept = createdDept;
        }
        empDepartmentId = adminDept._id;
      }
      
      // Find or create designation based on role name
      let designation = await Designation.findOne({
        company_id: employeeCompanyId,
        org_id: user.org_id,
        unit_id: employeeUnitId,
        name: { $regex: new RegExp(`^(${role.name}|Admin|Manager)$`, 'i') },
        isDeleted: false,
      }).session(session);
      
      if (!designation) {
        const [createdDesig] = await Designation.create([{
          name: role.name,
          company_id: employeeCompanyId,
          org_id: user.org_id,
          unit_id: employeeUnitId,
          status: 'active',
          created_by: currentUser.userId,
        }], { session });
        designation = createdDesig;
      }
      
      // Generate employee ID
      const employeeCount = await Employee.countDocuments({
        org_id: user.org_id,
        company_id: employeeCompanyId,
      }).session(session);
      const employeeId = `EMP${String(employeeCount + 1).padStart(5, '0')}`;
      
      // Create Employee record
      await Employee.create([{
        org_id: user.org_id,
        company_id: employeeCompanyId,
        unit_id: employeeUnitId,
        userId: user._id,
        employeeId,
        name: user.name,
        email: user.email,
        phone: user.phone || '0000000000',
        departmentId: empDepartmentId,
        designationId: designation._id,
        employmentType: 'FULL_TIME',
        joiningDate: new Date(),
        status: 'ACTIVE',
        salary: {
          basic: 0,
          hra: 0,
          grossSalary: 0,
          netSalary: 0,
        },
      }], { session });
    }

    await session.commitTransaction();
    session.endSession();

    [department, company] = await Promise.all([
      resolvedDepartmentId ? Department.findById(resolvedDepartmentId).select("name") : null,
      resolvedCompanyId ? Company.findById(resolvedCompanyId).select("company_name") : null,
    ]);

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }

  await sendEmail({
    to: data.email,
    subject: "Your HRMS Account Has Been Created 🚀",
    html: inviteTemplate({
      name: data.name || data.email.split("@")[0],
      companyName: company?.company_name || "HRMS",
      roleName: role.name,
      departmentName: department?.name || null,
      email: data.email,
      tempPassword,
    }),
  });

  // ✅ Return populated user data for frontend state update
  const populatedUser = await User.findById(user._id)
    .populate('roleId', 'name slug level')
    .populate('company_id', 'company_name logo_url')
    .populate('unit_id', 'unit_name logo_url')
    .lean();

  return {
    id: user._id,
    email: user.email,
    role: role.name,
    temp_password_sent: true,
    is_first_login: true,
    user: populatedUser, // ✅ Include full populated user for frontend
  };
};

// ─────────────────────────────────────────────────────────────
// GET INVITE BY TOKEN
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// GET USERS
// GET /users?page=1&limit=10&search=&status=&roleId=&departmentId=
// Returns users based on caller's level, EXCLUDING employees
// ─────────────────────────────────────────────────────────────
exports.getUsers = async (query, currentUser) => {
  const { page = 1, limit = 10, search, status, roleId, departmentId } = query;

  const filter = {
    ...buildScopeFilter(currentUser),
    is_deleted: false,
  };

  // ── LEVEL-BASED FILTERING: Exclude employees from admin users list ──
  const Role = require("../role/role.model");
  
  // Find the employee role to exclude
  const employeeRole = await Role.findOne({ slug: "employee" }).select("_id").lean();
  
  // Exclude employee role from results - employees are managed separately
  if (employeeRole) {
    filter.roleId = { $ne: employeeRole._id };
  }

  // ── SECURITY: Role Level Hierarchy Filtering - STRICT LEVEL ISOLATION ──
  // org_admin → can see/edit org + company (NOT unit)
  // company_admin → can see/edit company and unit users within their company
  // unit_admin → can see/edit ONLY unit
  const hierarchy = { org: 1, company: 2, unit: 3 };
  const currentUserLevelOrder = hierarchy[currentUser.level] || 3;
  
  const accessibleRoleLevels = getAccessibleRoleLevels(currentUser.level);
    
  const accessibleRoles = await Role.find({
    level: { $in: accessibleRoleLevels },
    $or: [
      { org_id: currentUser.orgId },
      { org_id: null, isSystem: true }
    ],
    isDeleted: false
  }).distinct('_id');
  
  // Combine with employee exclusion
  if (employeeRole) {
    filter.roleId = { 
      $in: accessibleRoles,
      $ne: employeeRole._id 
    };
  } else {
    filter.roleId = { $in: accessibleRoles };
  }

  // T-25 — Filter by role type (Administrative/Privilege/General)
  if (query.roleType) {
    const matchingRoles = await Role.find({
      userClass: query.roleType,
      isDeleted: false,
    }).select("_id");
    
    // Combine with employee exclusion
    const matchingRoleIds = matchingRoles.map(r => r._id);
    if (employeeRole) {
      filter.roleId = { 
        $in: matchingRoleIds,
        $ne: employeeRole._id 
      };
    } else {
      filter.roleId = { $in: matchingRoleIds };
    }
  }

  if (search) filter.email  = { $regex: search, $options: "i" };
  if (status) filter.status = status;
  
  // Specific roleId filter - but still exclude employee
  if (roleId) {
    if (employeeRole && roleId === employeeRole._id.toString()) {
      // If trying to filter by employee role, return empty
      return {
        users: [],
        pagination: { total: 0, page: Number(page), limit: Number(limit), pages: 0 }
      };
    }
    filter.roleId = roleId;
  }

  // departmentId — find matching user IDs in the Employee model
  if (departmentId) {
    const empUserIds = await Employee.distinct("userId", {
      ...buildScopeFilter(currentUser),
      departmentId,
      is_deleted: false,
    });
    filter._id = { $in: empUserIds };
  }

  const skip = (Number(page) - 1) * Number(limit);

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("-password -refreshTokens -mfaSecret -mfaTempSecret -mfaBackupCodes -loginAttempts -blockedAt -__v")
      .populate("roleId", "name slug level")
      .populate("company_id", "company_name logo_url")
      .populate("unit_id", "unit_name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    User.countDocuments(filter),
  ]);

  // Department + profilePhoto attach from Employee model (for unit-level users)
  const userIds   = users.map((u) => u._id);
  const employees = await Employee.find({
    userId:    { $in: userIds },
    ...buildScopeFilter(currentUser),
    isDeleted: false,
  }).select("userId departmentId profilePhoto").populate("departmentId", "name");

  const deptMap = {};
  const photoMap = {};
  employees.forEach((e) => {
    if (e.userId) {
      deptMap[e.userId.toString()] = e.departmentId;
      // Store profilePhoto from Employee (unit-level users store photo here)
      if (e.profilePhoto) {
        photoMap[e.userId.toString()] = e.profilePhoto;
      }
    }
  });

  const usersWithDept = users.map((u) => {
    const obj = u.toObject();
    const userLevel = obj.roleId?.level;
    
    // For unit-level users, use profilePhoto from Employee collection if available
    const profilePhoto = (userLevel === 'unit' && photoMap[u._id.toString()]) 
      ? photoMap[u._id.toString()] 
      : obj.profilePhoto;
    
    return {
      ...obj,
      profilePhoto, // Override with Employee photo for unit users
      department: deptMap[u._id.toString()] || null,
      company: obj.company_id || null,
      unit: obj.unit_id || null,
    };
  });

  return {
    users: usersWithDept,
    pagination: {
      total,
      page:  Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

// ─────────────────────────────────────────────────────────────
// UPDATE USER
// PUT /users/:id
// ─────────────────────────────────────────────────────────────
exports.updateUser = async (id, data, currentUser) => {

  const user = await User.findOne({
    _id:       id,
    ...buildScopeFilter(currentUser),
    is_deleted: false,
  });
  if (!user) throw new AppError("User not found", 404);

  const userRole = await Role.findById(user.roleId).select("level").lean();
  const userCurrentLevel = userRole?.level;
  const allowedTargetLevels = getAccessibleRoleLevels(currentUser.level);
  if (!allowedTargetLevels.includes(userCurrentLevel)) {
    throw new AppError(`You cannot edit users with ${userCurrentLevel || 'unknown'} level role`, 403);
  }

  // Role change track
  const roleChanged = data.roleId &&
    data.roleId.toString() !== user.roleId?.toString();
  const fromRoleId  = user.roleId || null;

  // Self-service profile edits are allowed, but privilege and account-state
  // changes must be performed by another authorized administrator.
  if (user._id.toString() === currentUser.userId) {
    if (roleChanged) {
      throw new AppError("You cannot change your own role", 403);
    }
    if (data.status && data.status !== user.status) {
      throw new AppError("You cannot change your own account status", 403);
    }
  }

  if (data.status && data.status !== user.status) {
    const { assertCompanyAdminDeactivationConfirmed } = require('../../utils/companyAdminStatusGuard');
    await assertCompanyAdminDeactivationConfirmed(user._id, data.status, data.confirmCompanyAdminDeactivation);
  }

  if (roleChanged) {
    const newRole = await Role.findById(data.roleId).select("slug level").lean();
    
    if (!newRole) {
      throw new AppError("Role not found", 404);
    }
    
    // ── SECURITY: Check role hierarchy - STRICT LEVEL ISOLATION ──
    const hierarchy = { org: 1, company: 2, unit: 3 };
    const currentUserLevelOrder = hierarchy[currentUser.level] || 3;
    const targetLevelOrder = hierarchy[newRole.level] || 3;
    
    // Get current target user's level
    const userCurrentLevelOrder = hierarchy[userCurrentLevel] || 3;
    
    // ── CRITICAL: Cannot edit users at higher level ──
    if (userCurrentLevelOrder < currentUserLevelOrder) {
      throw new AppError(`You cannot edit users with ${userCurrentLevel} level (parent hierarchy)`, 403);
    }

    // ── CRITICAL: Cannot promote users to parent level ──
    if (targetLevelOrder < userCurrentLevelOrder) {
      throw new AppError(`Cannot promote user from ${userCurrentLevel} to ${newRole.level} level (child cannot become parent)`, 403);
    }
    
    if (!allowedTargetLevels.includes(newRole.level)) {
      throw new AppError(`You cannot assign ${newRole.level} level role`, 403);
    }

    if (newRole.level !== userCurrentLevel) {
      throw new AppError(`You can only assign ${userCurrentLevel} level roles to this user`, 403);
    }

    if (newRole.level === "company") {
      await assertPlanAllowsCompanyRoles(currentUser.orgId);
    }
  }

  // Update user fields
  if (data.name)     user.name     = data.name;
  if (data.lastName) user.lastName = data.lastName;
  if (data.phone)    user.phone    = data.phone;
  if (data.status)   user.status   = data.status;
  if (roleChanged)   user.roleId   = data.roleId;

  // T-26 — Track blockedAt for JWT invalidation
  if (data.status === "BLOCKED" && !user.blockedAt) {
    user.blockedAt = new Date();
  } else if (data.status && data.status !== "BLOCKED") {
    user.blockedAt = null;
  }

  user.updatedBy = currentUser.userId;
  await user.save();

  // ─── Sync Employee.status when User.status changes ────────────────────────
  if (data.status) {
    const { syncUserStatusToEmployee } = require('../../utils/statusSync');
    await syncUserStatusToEmployee(user._id, data.status, currentUser.userId);
  }

  // Department change — Employee model
  let deptChanged = false;
  let fromDeptId  = null;

  if (data.departmentId) {
    const employee = await Employee.findOne({
      userId:    user._id,
      ...buildScopeFilter(currentUser),
      isDeleted: false,
    });

    if (employee) {
      deptChanged = data.departmentId.toString() !== employee.departmentId?.toString();
      fromDeptId  = employee.departmentId || null;

      if (deptChanged) {
        employee.departmentId = data.departmentId;
        employee.updatedBy    = currentUser.userId;
        await employee.save();
      }
    }
  }

  // Progression log
  if (roleChanged || deptChanged) {
    const changeType =
      roleChanged && deptChanged ? "both"
      : roleChanged              ? "role"
      :                            "department";

    await UserProgression.create({
      org_id:     currentUser.orgId,
      company_id: currentUser.companyId || null,
      unit_id:    currentUser.unitId    || null,
      userId:     user._id,
      fromRoleId: roleChanged ? fromRoleId        : undefined,
      toRoleId:   roleChanged ? data.roleId       : undefined,
      fromDeptId: deptChanged ? fromDeptId        : undefined,
      toDeptId:   deptChanged ? data.departmentId : undefined,
      changeType,
      changedBy:  currentUser.userId,
      note:       data.note || null,
    });

    const empForCache = await Employee.findOne({
      userId:    user._id,
      ...buildScopeFilter(currentUser),
      isDeleted: false,
    }).select("_id").lean();

    if (empForCache) {
      invalidateEmployeeCache(
        currentUser.orgId.toString(),
        empForCache._id.toString()
      );
    }
  }

  // ── Return populated user for frontend update ──
  const updatedUser = await User.findById(user._id)
    .populate('roleId', 'name slug level')
    .populate('company_id', 'company_name logo_url')
    .populate('unit_id', 'unit_name logo_url')
    .lean();

  return updatedUser;
};

// ─────────────────────────────────────────────────────────────
// GET PROGRESSION HISTORY
// GET /users/:id/progression
// ─────────────────────────────────────────────────────────────
exports.getProgressionHistory = async (id, currentUser) => {
  const user = await User.findOne({
    _id:       id,
    ...buildScopeFilter(currentUser),
    isDeleted: false,
  });
  if (!user) throw new AppError("User not found", 404);

  const userRole = await Role.findById(user.roleId).select("level").lean();
  if (!getAccessibleRoleLevels(currentUser.level).includes(userRole?.level)) {
    throw new AppError(`You cannot view users with ${userRole?.level || 'unknown'} level role`, 403);
  }

  return await UserProgression.find({
    userId:  id,
    org_id:  currentUser.orgId,
  })
    .populate("fromRoleId", "name")
    .populate("toRoleId",   "name")
    .populate("fromDeptId", "name")
    .populate("toDeptId",   "name")
    .populate("changedBy",  "name email")
    .sort({ createdAt: -1 });
};

// ─────────────────────────────────────────────────────────────
// DELETE USER (Soft)
// DELETE /users/:id
// ─────────────────────────────────────────────────────────────
exports.deleteUser = async (id, currentUser, confirmCompanyAdminDeactivation = false) => {
  const scopeFilter = buildScopeFilter(currentUser);
  
  console.log('🔍 Delete user request:', {
    targetUserId: id,
    currentUser: {
      userId: currentUser.userId,
      orgId: currentUser.orgId,
      companyId: currentUser.companyId,
      unitId: currentUser.unitId,
      role: currentUser.role,
      level: currentUser.level
    },
    scopeFilter: scopeFilter
  });
  
  const user = await User.findOne({
    _id:       id,
    ...scopeFilter,
    is_deleted: false,  // ✅ Fixed: model uses is_deleted, not isDeleted
  });
  
  console.log('🔍 User found:', user ? { id: user._id, email: user.email, org_id: user.org_id } : null);
  
  if (!user) throw new AppError("User not found", 404);

  const userRole = await Role.findById(user.roleId).select("level").lean();
  if (!getAccessibleRoleLevels(currentUser.level).includes(userRole?.level)) {
    throw new AppError(`You cannot delete users with ${userRole?.level || 'unknown'} level role`, 403);
  }

  if (user._id.toString() === currentUser.userId) {
    throw new AppError("You cannot delete your own account", 400);
  }

  const { assertCompanyAdminDeactivationConfirmed } = require('../../utils/companyAdminStatusGuard');
  await assertCompanyAdminDeactivationConfirmed(user._id, 'INACTIVE', confirmCompanyAdminDeactivation);

  user.isDeleted = true;
  user.status    = "INACTIVE";
  user.updatedBy = currentUser.userId;
  await user.save();

  // ─── Sync Employee.status when User is deleted ───────────────────────────
  const { syncUserStatusToEmployee } = require('../../utils/statusSync');
  await syncUserStatusToEmployee(id, 'INACTIVE', currentUser.userId);

  return { message: "User deleted successfully" };
};