// modules/employee/employee.service.js
//
// UPDATED — tenantId removed
// Scope: org_id + company_id + unit_id
//
// Role-based scope:
//   Org Admin     → org_id filter only
//   Company Admin → org_id + company_id
//   Unit Admin    → org_id + company_id + unit_id
//   HR Manager    → org_id + company_id + unit_id
//   Manager       → org_id + company_id + unit_id
//   Employee      → self only

const Employee         = require("./models/employee.model");
const AppError         = require("../../utils/appError");
const User             = require("../auth/models/user.model");
const Role             = require("../role/role.model");
const bcrypt           = require("bcryptjs");
const { sendEmail }    = require("../../utils/email/email");
const { credentialsTemplate } = require("../../utils/email/templates/credentials");
const EmployeeDocument = require("./models/employeeDocument.model");
// seedLeaveBalances removed - balances are now calculated dynamically from policy
const Subscription = require("../subscription/models/subscription.Models"); // T-27
const auditService = require("../auditLogs/auditLog.service");
const Roster        = require("../shift/models/roster.model"); // CRITICAL: import Roster for cascade delete
const { assertPlanAllowsCompanyRoles } = require("../../utils/companyRoleEntitlement");

// ─── Helper — normalize phone number ──────────────────────────
// Removes +91 prefix, removes leading 0, keeps only 10 digits
const normalizePhoneNumber = (phone) => {
  if (!phone) return phone;
  // Remove +91 prefix with optional space, remove leading 0
  return phone.replace(/^\+91\s?|^0/g, '').trim();
};

// ─── Build scope filter from req.user ─────────────────────────
// Org Admin sees all employees in org
// Company Admin sees all employees in company
// Unit Admin / HR / Manager sees only their unit
const buildScopeFilter = (user) => {
  if (user.role === "SUPER_ADMIN") return {};

  const filter = { org_id: user.orgId };

  if (user.level === "company" || user.level === "unit") {
    filter.company_id = user.companyId;
  }

  if (user.level === "unit") {
    filter.unit_id = user.unitId;
  }

  return filter;
};

// ─── Helper — generate employeeId ─────────────────────────────
// BUG-09 fix: use last employeeId number instead of count
// count causes duplicates when employees are deleted or sequence gaps exist
const generateEmployeeId = async (org_id, company_id) => {
  const last = await Employee.findOne(
    { org_id, company_id, employeeId: { $regex: /^EMP\d+$/ } },
    { employeeId: 1 },
    { sort: { employeeId: -1 } }
  ).lean();

  let nextNum = 1;
  if (last?.employeeId) {
    const lastNum = parseInt(last.employeeId.replace("EMP", ""), 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }

  const padded = String(nextNum).padStart(4, "0");
  return `EMP${padded}`;
};

// ─── Helper — calculate salary ────────────────────────────────
const calculateSalary = (salary) => {
  const grossSalary =
    (salary.basic            || 0) +
    (salary.hra              || 0) +
    (salary.travelAllowance  || 0) +
    (salary.medicalAllowance || 0) +
    (salary.specialAllowance || 0);

  const totalDeductions =
    (salary.pf  || 0) +
    (salary.esi || 0) +
    (salary.tds || 0);

  return { ...salary, grossSalary, netSalary: grossSalary - totalDeductions };
};

// ─── T-28: Circular reporting chain check ────────────────────
const hasCircularChain = async (employeeId, managerId, maxDepth = 10) => {
  if (!managerId) return false;
  if (String(employeeId) === String(managerId)) return true;

  let current = managerId;
  for (let i = 0; i < maxDepth; i++) {
    const emp = await Employee.findById(current).select("reportingManagerId").lean();
    if (!emp || !emp.reportingManagerId) return false;
    if (String(emp.reportingManagerId) === String(employeeId)) return true;
    current = emp.reportingManagerId;
  }
  return false;
};

// ─── CREATE EMPLOYEE ──────────────────────────────────────────
exports.createEmployee = async (payload, user) => {
  const { email, salary, departmentId, designationId, reportingManagerId, unit_id } = payload;
  if (designationId) {
  const Designation = require("../designation/designation.model");
   const desig = await Designation.findOne({
   _id: designationId, company_id: user.companyId, isDeleted: false, status: "active",
  });
  if (!desig) throw new AppError("Designation not found or inactive", 404);
  }

  // unit_id — from payload or from user context
  const employeeUnitId = unit_id || user.unitId;
  if (!employeeUnitId) throw new AppError("unit_id is required", 400);

  // Check for duplicate email addresses within the same company
  const existing = await Employee.findOne({
    email,
    org_id:     user.orgId,
    company_id: user.companyId,
    isDeleted:  false
  });
  if (existing) throw new AppError("Employee already exists with this email", 409);

  // Reporting manager check
  if (reportingManagerId) {
    const manager = await Employee.findOne({
      _id:        reportingManagerId,
      org_id:     user.orgId,
      company_id: user.companyId,
      isDeleted:  false,
      status:     "ACTIVE"
    });
    if (!manager) throw new AppError("Reporting manager not found or inactive", 404);
  }

  // T-27 — Seat limit enforcement
  const subscription = await Subscription.findOne({
    org_id:    user.orgId,
    is_active: true,
  }).select("plan_snapshot.seat_limit").lean();

  const seatLimit = subscription?.plan_snapshot?.seat_limit;
  if (seatLimit !== null && seatLimit !== undefined) {
    const currentCount = await Employee.countDocuments({
      company_id: user.companyId,
      isDeleted:  false,
      status:     { $nin: ["TERMINATED"] },
    });
    if (currentCount >= seatLimit) {
      throw new AppError(
        `Seat limit reached (${seatLimit}). Please upgrade your plan to add more employees.`,
        403
      );
    }
  }

  // Generate employeeId
  const employeeId = await generateEmployeeId(user.orgId, user.companyId);

  // Calculate salary
  const calculatedSalary = salary ? calculateSalary(salary) : undefined;

  // Normalize phone number - extract +91 if present
  let normalizedPhone = payload.phone ? normalizePhoneNumber(payload.phone) : payload.phone;

  const employee = await Employee.create({
    ...payload,
    phone: normalizedPhone,
    employeeId,
    salary:     calculatedSalary,
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    employeeUnitId,
    createdBy:  user.userId
  });

  // ─── Create Joining Timeline Event ──────────────────────────────────────
  const timelineService = require('./employeeTimeline.service');
  await timelineService.createJoiningEvent(employee.toObject(), user.userId);

  // NOTE: Leave balance seeding removed - balances calculated dynamically from active policy

  return await Employee.findById(employee._id)
    .populate("departmentId",       "name")
    .populate("designationId",      "name")
    .populate("reportingManagerId", "name employeeId profilePhoto")
    .populate("unit_id",            "name")
    .populate("company_id",         "company_name");
};

// ─── GET ALL ──────────────────────────────────────────────────
exports.getEmployees = async (user, query) => {
  const {
    page = 1, limit = 10, search,
    departmentId, designationId, employmentType, status, unit_id, employeeId
  } = query;

  const filter = {
    isDeleted: false,
    ...buildScopeFilter(user)
  };

  if (employeeId)     filter._id           = employeeId;
  if (departmentId)   filter.departmentId   = departmentId;
  if (designationId)  filter.designationId  = designationId;
  if (employmentType) filter.employmentType = employmentType;
  if (status)         filter.status         = status;
  
  // Enterprise Data Isolation: Only allow unit_id override if user has NO unitId
  // Unit admins cannot query other units' employees
  if (unit_id && !user.unitId) filter.unit_id = unit_id;

  if (search) {
    filter.$or = [
      { name:       { $regex: search, $options: "i" } },
      { email:      { $regex: search, $options: "i" } },
      { employeeId: { $regex: search, $options: "i" } },
      { phone:      { $regex: search, $options: "i" } }
    ];
  }

  const skip = (Number(page) - 1) * Number(limit);

  // ─── Salary Visibility Rules ─────────────────────────────────
  // Only HR and Admin roles can see salary in list view
  // Employee can view their own salary via GET by ID
  // Manager cannot see subordinates' salary
  const CAN_VIEW_SALARY_ROLES = ['SUPER_ADMIN', 'org_admin', 'company_admin', 'unit_admin', 'hr_manager', 'company_hr_manager'];  
  // DEBUG: Log to see what user.role is
  console.log('=== SALARY VISIBILITY DEBUG ===');
  console.log('user.role:', user.role);
  console.log('user.roleId:', user.roleId);
  console.log('user.level:', user.level);
  console.log('CAN_VIEW_SALARY_ROLES:', CAN_VIEW_SALARY_ROLES);
  console.log('includeSalary:', CAN_VIEW_SALARY_ROLES.includes(user.role));
    const includeSalary = CAN_VIEW_SALARY_ROLES.includes(user.role);

  // Build select fields based on role - always include profilePhoto
  let selectFields = "-__v -isDeleted";
  if (!includeSalary) {
    selectFields += " -salary -bankDetails";
  }

  const [employees, total] = await Promise.all([
    Employee.find(filter)
      .populate("org_id",             "name")
      .populate("company_id",         "company_name")
      .populate("unit_id",            "name")
      .populate("departmentId",       "name")
      .populate("designationId",      "name")
      .populate("reportingManagerId", "name employeeId profilePhoto")
      .select(selectFields)  // profilePhoto is included by default
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Employee.countDocuments(filter)
  ]);

  return {
    employees,
    pagination: {
      total,
      page:       Number(page),
      limit:      Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
      hasNext:    Number(page) < Math.ceil(total / Number(limit)),
      hasPrev:    Number(page) > 1
    }
  };
};

// ─── GET ONE ──────────────────────────────────────────────────
exports.getEmployeeById = async (id, user) => {
  const filter = { _id: id, isDeleted: false, ...buildScopeFilter(user) };

  const employee = await Employee.findOne(filter)
    .populate("departmentId",       "name")
    .populate("designationId",      "name")
    .populate("reportingManagerId", "name employeeId profilePhoto")
    .populate("unit_id",            "name")
    .populate("company_id",         "company_name")
    .populate("createdBy",          "name email")
    .populate("updatedBy",          "name email")
    .populate("userId",             "email status roleId")
    .select("-__v -isDeleted");  // profilePhoto is included by default

  if (!employee) throw new AppError("Employee not found", 404);

  // ─── Salary Visibility for GET BY ID ─────────────────────────────────
  // Admin/HR: Full access if within scope (same unit/company)
  // Employee: Can view OWN salary (read-only)
  // Manager: Cannot view subordinates' salary
  const CAN_VIEW_ALL_SALARIES_ROLES = ['SUPER_ADMIN', 'org_admin', 'company_admin', 'unit_admin', 'hr_manager', 'company_hr_manager'];
  const canViewAllSalaries = CAN_VIEW_ALL_SALARIES_ROLES.includes(user.role);
  const isOwnRecord = employee.userId && String(employee.userId) === String(user.userId);

  // If not admin AND not own record, hide salary
  if (!canViewAllSalaries && !isOwnRecord) {
    employee.salary = undefined;
    employee.bankDetails = undefined;
  }

  // Add permission flags for frontend to know edit access
  const CAN_EDIT_SALARY_ROLES = ['SUPER_ADMIN', 'org_admin', 'company_admin', 'unit_admin', 'hr_manager', 'company_hr_manager'];
  employee._doc = employee._doc || {};
  employee._doc.canEditSalary = CAN_EDIT_SALARY_ROLES.includes(user.role);
  employee._doc.isOwnRecord = isOwnRecord;

  return employee;
};

// ─── UPDATE ───────────────────────────────────────────────────
exports.updateEmployee = async (id, data, user) => {
  const filter = { _id: id, isDeleted: false, ...buildScopeFilter(user) };

  const employee = await Employee.findOne(filter);
  if (!employee) throw new AppError("Employee not found", 404);
  const { confirmCompanyAdminDeactivation } = data;
  delete data.confirmCompanyAdminDeactivation;
  const isOwnRecord = employee.userId && String(employee.userId) === String(user.userId);
  if (isOwnRecord && data.status && data.status !== employee.status) {
    throw new AppError("You cannot change your own employment status", 400);
  }

  // Restricted fields - NEVER allow these to be updated by anyone
  const restricted = ["email", "employeeId", "org_id", "company_id", "unit_id", "userId", "createdBy", "isDeleted"];
  restricted.forEach(f => delete data[f]);

  // E-08 — Employee self-service: can update personal details except salary/documents
  // Fields EMPLOYEES CAN update for themselves
  const EMPLOYEE_ALLOWED_FIELDS = [
    "name", "phone", "alternatePhone", "dateOfBirth", "gender", "bloodGroup", 
    "maritalStatus", "profilePhoto", "about",
    "currentAddress", "permanentAddress",
    "emergencyContact",
    "familyDetails", "education", "experience"
  ];

  // Fields EMPLOYEES CANNOT update (admin/HR only)
  const EMPLOYEE_RESTRICTED_FIELDS = [
    "departmentId", "designationId", "reportingManagerId", 
    "employmentType", "joiningDate", "confirmationDate", 
    "status", "exitDate", "exitReason",
    "salary", "bankDetails",
    "documents"
  ];

  // Admin/HR can update these additional fields
  const ADMIN_HR_EDITABLE_FIELDS = ["name", "joiningDate", "employmentType", "departmentId"];
  const CAN_EDIT_EMPLOYEE_DETAILS = ['SUPER_ADMIN', 'org_admin', 'company_admin', 'unit_admin', 'hr_manager', 'company_hr_manager', 'admin', 'hr'];

  // ─── Salary Update Permission Check ─────────────────────────────────
  // Only Admin/HR can update salary/bankDetails
  const CAN_EDIT_SALARY = ['SUPER_ADMIN', 'org_admin', 'company_admin', 'unit_admin', 'hr_manager', 'company_hr_manager'];
  const salaryFieldsPresent = data.salary || data.bankDetails;
  
  if (salaryFieldsPresent && !CAN_EDIT_SALARY.includes(user.role)) {
    delete data.salary;
    delete data.bankDetails;
    // Log attempt but don't throw - just ignore
    console.log(`User ${user.userId} (${user.role}) attempted to update salary - permission denied`);
  }

  // Admin/HR can update name, joiningDate, employmentType - remove from restricted list
  if (CAN_EDIT_EMPLOYEE_DETAILS.includes(user.role)) {
    // These fields are allowed, so remove them from restrictions
    ADMIN_HR_EDITABLE_FIELDS.forEach(f => {
      const idx = EMPLOYEE_RESTRICTED_FIELDS.indexOf(f);
      if (idx > -1) EMPLOYEE_RESTRICTED_FIELDS.splice(idx, 1);
    });
  }

  if (user.role === "employee") {
    const emp = await Employee.findOne({
      userId: user.userId,
      isDeleted: false,
    }).select("_id").lean();

    if (!emp || String(emp._id) !== String(id)) {
      throw new AppError("You can only update your own profile", 403);
    }

    // Remove restricted fields from data
    EMPLOYEE_RESTRICTED_FIELDS.forEach(f => delete data[f]);

    // Check if any remaining fields are not in allowed list
    const attempts = Object.keys(data).filter(key => !EMPLOYEE_ALLOWED_FIELDS.includes(key));
    if (attempts.length > 0) {
      console.log(`Employee attempted to update restricted fields: ${attempts.join(", ")}`);
    }

    if (Object.keys(data).length === 0) {
      throw new AppError(
        "You can update: personal info, address, emergency contact, profile photo, and about section",
        400
      );
    }
  }


  // Status change security
  if (data.status) {
    if (employee.status === "TERMINATED" && data.status === "ACTIVE") {
      throw new AppError("Terminated employee cannot be reactivated", 400);
    }
    if (data.status === "TERMINATED" && !data.exitDate && !employee.exitDate) {
      throw new AppError("Exit date is required when terminating employee", 400);
    }
    if (employee.userId) {
      const { mapEmployeeStatusToUser } = require('../../utils/statusSync');
      const { assertCompanyAdminDeactivationConfirmed } = require('../../utils/companyAdminStatusGuard');
      await assertCompanyAdminDeactivationConfirmed(
        employee.userId, mapEmployeeStatusToUser(data.status), confirmCompanyAdminDeactivation
      );
    }
  }

  // Reporting manager check (T-28)
  if (data.reportingManagerId) {
    if (String(data.reportingManagerId) === String(id)) {
      throw new AppError("Employee cannot be their own manager", 400);
    }
    const manager = await Employee.findOne({
      _id:        data.reportingManagerId,
      org_id:     employee.org_id,
      company_id: employee.company_id,
      isDeleted:  false,
      status:     "ACTIVE"
    });
    if (!manager) throw new AppError("Reporting manager not found or inactive", 404);

    // T-28 — Circular chain detection
    const isCircular = await hasCircularChain(id, data.reportingManagerId);
    if (isCircular) {
      throw new AppError(
        "Circular reporting chain detected. This assignment would create a loop.",
        400
      );
    }
  }

  // Department check
  if (data.departmentId) {
    const Department = require("../department/department.model");
    const dept = await Department.findOne({
      _id:        data.departmentId,
      company_id: employee.company_id,
      isDeleted:  false
    });
    if (!dept) throw new AppError("Department not found", 404);
  }

  // Designation check
  if (data.designationId) {
    const Designation = require("../designation/designation.model");
    const desig = await Designation.findOne({
      _id:        data.designationId,
      company_id: user.companyId,
      isDeleted:  false,
      status:     "active",
    });
  if (!desig) throw new AppError("Designation not found or inactive", 404);
  }

  // Salary recalculate
  if (data.salary) {
    data.salary = calculateSalary({ ...employee.salary.toObject(), ...data.salary });
  }

  // Normalize phone number - extract +91 if present
  if (data.phone) {
    data.phone = normalizePhoneNumber(data.phone);
  }

  // Build diff for audit log (salary changes)
  const salaryFields = ["salary.basic", "salary.hra", "salary.travelAllowance",
                        "salary.medicalAllowance", "salary.specialAllowance", "salary.grossSalary"];
  const oldObj = { salary: employee.salary?.toObject?.() || employee.salary };
  
  // ─── Track Timeline Changes ──────────────────────────────────────────────
  const timelineService = require('./employeeTimeline.service');
  await timelineService.trackEmployeeChanges(
    employee._id,
    employee.toObject(),
    data,
    user.userId
  );
  
  Object.assign(employee, data);
  employee.updatedBy = user.userId;
  await employee.save();

  // ─── Sync User.status when Employee.status changes ────────────────────────
  if (data.status && employee.userId) {
    const { syncEmployeeStatusToUser } = require('../../utils/statusSync');
    await syncEmployeeStatusToUser(employee._id, data.status, user.userId);
  }

  // Audit log — detect what changed
  const newObj = { salary: employee.salary?.toObject?.() || employee.salary };
  const changes = auditService.buildDiff(oldObj, newObj, salaryFields);
  
  const action = data.salary ? "SALARY_UPDATED" : "EMPLOYEE_UPDATED";
  auditService.log({
    action,
    module:     "employee",
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    user.unitId,
    actor:      { userId: user.userId, name: user.name, role: user.role, email: user.email },
    target:     { type: "Employee", id: employee._id, name: employee.name, employeeId: employee.employeeId },
    changes,
    description: `${action} by ${user.role}`,
  }).catch(() => {});

  return await Employee.findById(employee._id)
    .populate("departmentId",       "name")
    .populate("designationId",      "name")
    .populate("reportingManagerId", "name employeeId profilePhoto")
    .populate("unit_id",            "name")
    .populate("updatedBy",          "name email")
    .select("-__v -isDeleted");  // profilePhoto is included by default
};

// ─── DELETE ───────────────────────────────────────────────────
exports.deleteEmployee = async (id, user, confirmCompanyAdminDeactivation = false) => {
  const filter = { _id: id, isDeleted: false, ...buildScopeFilter(user) };

  const employee = await Employee.findOne(filter);
  if (!employee) throw new AppError("Employee not found", 404);

  // Self-lockout prevention — you can never delete your own employee record
  if (employee.userId && String(employee.userId) === String(user.userId)) {
    throw new AppError("You cannot delete your own employee record", 400);
  }

  if (employee.status === "ACTIVE") {
    throw new AppError("Active employee cannot be deleted. Terminate or deactivate first.", 400);
  }

  if (employee.userId) {
    const { assertCompanyAdminDeactivationConfirmed } = require('../../utils/companyAdminStatusGuard');
    await assertCompanyAdminDeactivationConfirmed(employee.userId, 'INACTIVE', confirmCompanyAdminDeactivation);
    await User.findByIdAndUpdate(employee.userId, { status: "INACTIVE" });
  }

  // CRITICAL GAP 2: Revoke all active rosters for this employee
  // This prevents orphaned roster assignments when employee is deleted
  await Roster.updateMany(
    { employee_id: employee._id, status: "ACTIVE", is_deleted: false },
    { $set: { status: "REVOKED", revokedAt: new Date(), revokedBy: user.userId, revokeReason: "Employee deleted" } }
  );

  employee.isDeleted = true;
  employee.updatedBy = user.userId;
  await employee.save();

  return { message: "Employee deleted successfully" };
};

// ─── ACTIVATE LOGIN ───────────────────────────────────────────
exports.activateLogin = async (id, payload, user) => {
  const { roleId } = payload;

  const filter = { _id: id, isDeleted: false, ...buildScopeFilter(user) };
  const employee = await Employee.findOne(filter);
  if (!employee) throw new AppError("Employee not found", 404);

  // Block sending login credentials before the employee's official joining
  // date — no point issuing access (or a temp-password email) to someone
  // who hasn't started yet. HR should activate this again on/after the
  // joining date instead.
  if (employee.joiningDate && new Date(employee.joiningDate) > new Date()) {
    const { formatDateOnly } = require("../../utils/timezone");
    throw new AppError(
      `Cannot activate login before joining date (${formatDateOnly(employee.joiningDate)}). Please activate on or after this date.`,
      400
    );
  }

  const role = await Role.findOne({
    _id: roleId,
    isDeleted: false,
    $or: [{ org_id: user.orgId }, { org_id: null, isSystem: true }],
  });
  if (!role) throw new AppError("Role not found", 404);

  const hierarchy = { org: 3, company: 2, unit: 1 };
  if ((hierarchy[role.level] || 0) > (hierarchy[user.level] || 0)) {
    throw new AppError(`You cannot assign ${role.level} level role`, 403);
  }
  if (role.level === "company") {
    await assertPlanAllowsCompanyRoles(employee.org_id);
    if (!employee.company_id) throw new AppError("A company is required for a company-level role", 400);
  }

  // Check existing user
  const existingUser = await User.findOne({
    email:  employee.email,
    org_id: employee.org_id,
  });
  if (existingUser) {
    // This branch reactivates an account without assigning the requested role.
    // Do not reactivate a company-level account after its plan loses access.
    if (existingUser.roleId && String(existingUser.roleId) !== String(role._id)) {
      const existingRole = await Role.findById(existingUser.roleId).select("level").lean();
      if (existingRole?.level === "company") {
        await assertPlanAllowsCompanyRoles(employee.org_id);
      }
    }
    if (existingUser.isDeleted) {
      existingUser.isDeleted = false;
    }
    if (existingUser.status !== "ACTIVE") {
      existingUser.status    = "ACTIVE";
      existingUser.updatedBy = user.userId;
      await existingUser.save();
    } else if (existingUser.isModified()) {
      await existingUser.save();
    }
    
    // ALWAYS sync Employee.status to ACTIVE when activating login
    // Using findByIdAndUpdate to guarantee DB update (avoid Mongoose document tracking issues)
    console.log('=== ACTIVATE LOGIN DEBUG ===');
    console.log('Employee ID:', employee._id);
    console.log('Employee email:', employee.email);
    console.log('Employee current status (before update):', employee.status);
    console.log('Existing User ID:', existingUser._id);
    
    const updateResult = await Employee.findByIdAndUpdate(
      employee._id,
      {
        status: "ACTIVE",
        userId: existingUser._id,
        updatedBy: user.userId
      },
      { new: true }
    );
    
    console.log('Employee status AFTER update:', updateResult?.status);
    console.log('Update result:', updateResult ? 'SUCCESS' : 'FAILED');
    console.log('=== END DEBUG ===');
    
    return {
      message: "Login already exists — linked successfully",
      user: { id: existingUser._id, email: existingUser.email, role: role.name, status: existingUser.status }
    };
  }

  const tempPassword = process.env.NODE_ENV === "development" ? "Test@1234" : Math.random().toString(36).slice(-8) + "A1@";
  const hashedPassword = await bcrypt.hash(tempPassword, 10);

  const newUser = await User.create({
    org_id:         employee.org_id,
    company_id:     employee.company_id,
    unit_id:        employee.unit_id,
    name:           employee.name,
    email:          employee.email,
    phone:          employee.phone,
    password:       hashedPassword,
    roleId:         role._id,
    status:         "ACTIVE",
    is_first_login: true,
    createdBy:      user.userId
  });

  employee.status    = "ACTIVE";
  employee.userId    = newUser._id;
  employee.updatedBy = user.userId;
  await employee.save();

  await sendEmail({
    to:      employee.email,
    subject: "Your HRMS Login Credentials",
    html:    credentialsTemplate({
      name:        employee.name,
      email:       employee.email,
      password:    tempPassword,
      companyName: ""
    })
  });

  return {
    message: "Login activated successfully",
    user: { id: newUser._id, email: newUser.email, role: role.name }
  };
};

// ─── CHANGE STATUS ────────────────────────────────────────────
exports.changeStatus = async (id, payload, user) => {
  const { status, confirmCompanyAdminDeactivation } = payload;

  const validStatuses = ["ACTIVE", "INACTIVE", "TERMINATED", "ON_LEAVE", "ON_NOTICE"];
  if (!validStatuses.includes(status)) {
    throw new AppError("Invalid status", 400);
  }

 const filter = { _id: id, isDeleted: false, ...buildScopeFilter(user) };
  const employee = await Employee.findOne(filter);
  if (!employee) throw new AppError("Employee not found", 404);

  // Self-lockout prevention — you can never change your own employment status,
  // even to something like ON_LEAVE. Same principle as user.service.js's deleteUser.
  if (employee.userId && String(employee.userId) === String(user.userId)) {
    throw new AppError("You cannot change your own employment status", 400);
  }

  if (employee.status === status) throw new AppError(`Employee is already ${status}`, 400)

  if (employee.userId) {
    const { mapEmployeeStatusToUser } = require('../../utils/statusSync');
    const { assertCompanyAdminDeactivationConfirmed } = require('../../utils/companyAdminStatusGuard');
    await assertCompanyAdminDeactivationConfirmed(
      employee.userId, mapEmployeeStatusToUser(status), confirmCompanyAdminDeactivation
    );
  }

  employee.status    = status;
  employee.updatedBy = user.userId;
  await employee.save();

  // ─── Sync User.status with mapped value ─────────────────────────────────────
  if (employee.userId) {
    const { syncEmployeeStatusToUser } = require('../../utils/statusSync');
    await syncEmployeeStatusToUser(employee._id, status, user.userId);
  }

  return {
    message: `Employee ${status === "ACTIVE" ? "activated" : "status updated"} successfully`,
    employee: { id: employee._id, name: employee.name, status: employee.status }
  };
};

// ─── DOCUMENTS ────────────────────────────────────────────────
exports.uploadDocument = async (employeeId, payload, file, user) => {
  const filter = { _id: employeeId, isDeleted: false, ...buildScopeFilter(user) };
  const employee = await Employee.findOne(filter);
  if (!employee) throw new AppError("Employee not found", 404);

  const document = await EmployeeDocument.create({
    org_id:       employee.org_id,
    company_id:   employee.company_id,
    employeeId:   employee._id,
    documentType: payload.documentType,
    category:     payload.category,
    name:         payload.name || file.originalname,
    url:          file.path,
    fileSize:     file.size,
    fileType:     file.mimetype,
    uploadedBy:   user.userId
  });

  return document;
};

exports.getDocuments = async (employeeId, user) => {
  const filter = { _id: employeeId, isDeleted: false, ...buildScopeFilter(user) };
  const employee = await Employee.findOne(filter);
  if (!employee) throw new AppError("Employee not found", 404);

  return await EmployeeDocument.find({ employeeId: employee._id, isDeleted: false })
    .select("-__v")
    .sort({ createdAt: -1 });
};

exports.deleteDocument = async (employeeId, docId, user) => {
  const filter = { _id: employeeId, isDeleted: false, ...buildScopeFilter(user) };
  const employee = await Employee.findOne(filter);
  if (!employee) throw new AppError("Employee not found", 404);

  const document = await EmployeeDocument.findOne({ _id: docId, employeeId: employee._id, isDeleted: false });
  if (!document) throw new AppError("Document not found", 404);

  document.isDeleted = true;
  await document.save();

  return { message: "Document deleted successfully" };
};

exports.verifyDocument = async (employeeId, docId, user) => {
  const document = await EmployeeDocument.findOne({ _id: docId, employeeId, isDeleted: false });
  if (!document) throw new AppError("Document not found", 404);

  document.isVerified = true;
  document.verifiedBy = user.userId;
  document.verifiedAt = new Date();
  await document.save();

  return document;
};

// ─── E-08: GET MY PROFILE ─────────────────────────────────────
exports.getMyProfile = async (user) => {
  // Validate user has required org scope
  if (!user.userId) {
    throw new AppError("User ID not found in token", 401);
  }
  if (!user.orgId) {
    throw new AppError("Organization ID not found. Please login again.", 401);
  }

  const employee = await Employee.findOne({
    userId:    user.userId,
    org_id:    user.orgId,
    isDeleted: false,
  })
    .populate("departmentId",       "name")
    .populate("designationId",      "name")
    .populate("reportingManagerId", "name employeeId profilePhoto")
    .populate("unit_id",            "name")
    .select("-__v -isDeleted -salary -bankDetails") // salary + bank HR only, profilePhoto included
    .lean();

  if (!employee) throw new AppError("Employee profile not found", 404);
  return employee;
};

// ─── E-09: GET MY DOCUMENTS ───────────────────────────────────
exports.getMyDocuments = async (user) => {
  const employee = await Employee.findOne({
    userId:    user.userId,
    org_id:    user.orgId,
    isDeleted: false,
  }).select("_id").lean();

  if (!employee) throw new AppError("Employee profile not found", 404);

  return await EmployeeDocument.find({
    employeeId: employee._id,
    isDeleted:  false,
  })
    .select("-__v")
    .sort({ createdAt: -1 });
};


exports.downloadMyDocument = async (docId, user) => {
  const employee = await Employee.findOne({
    userId:    user.userId,
    org_id:    user.orgId,
    isDeleted: false,
  }).select("_id").lean();

  if (!employee) throw new AppError("Employee profile not found", 404);

  const doc = await EmployeeDocument.findOne({
    _id:        docId,
    employeeId: employee._id,   // Security: only retrieve this employee's document
    isDeleted:  false,
  }).lean();

  if (!doc) throw new AppError("Document not found", 404);

  // Cloudinary "fl_attachment" flag force-downloads instead of opening inline
  const downloadUrl = doc.url.includes("cloudinary.com")
    ? doc.url.replace("/upload/", "/upload/fl_attachment/")
    : doc.url;

  return downloadUrl;
};

// ─── E-10: PROFILE COMPLETION INDICATOR ──────────────────────
exports.getProfileCompletion = async (user) => {
  const employee = await Employee.findOne({
    userId:    user.userId,
    org_id:    user.orgId,
    isDeleted: false,
  }).lean();

  if (!employee) throw new AppError("Employee profile not found", 404);

  // Check whether each field is filled in
  const checks = {
    basicInfo: {
      label:  "Basic Information",
      fields: {
        phone:         !!employee.phone,
        dateOfBirth:   !!employee.dateOfBirth,
        gender:        !!employee.gender,
        maritalStatus: !!employee.maritalStatus,
        bloodGroup:    !!employee.bloodGroup,
      },
    },
    address: {
      label:  "Address",
      fields: {
        currentAddress:   !!(employee.currentAddress?.city),
        permanentAddress: !!(employee.permanentAddress?.city),
      },
    },
    emergencyContact: {
      label:  "Emergency Contact",
      fields: {
        emergencyName:     !!employee.emergencyContact?.name,
        emergencyPhone:    !!employee.emergencyContact?.phone,
        emergencyRelation: !!employee.emergencyContact?.relation,
      },
    },
    bankDetails: {
      label:  "Bank Details",
      fields: {
        accountNumber: !!employee.bankDetails?.accountNumber,
        ifscCode:      !!employee.bankDetails?.ifscCode,
        bankName:      !!employee.bankDetails?.bankName,
      },
    },
    profilePhoto: {
      label:  "Profile Photo",
      fields: {
        profilePhoto: !!employee.profilePhoto,
      },
    },
  };

  // Calculate the score
  let totalFields   = 0;
  let filledFields  = 0;
  const sections    = [];
  const missingFields = [];

  for (const [sectionKey, section] of Object.entries(checks)) {
    const fieldEntries  = Object.entries(section.fields);
    const sectionTotal  = fieldEntries.length;
    const sectionFilled = fieldEntries.filter(([, v]) => v).length;

    totalFields  += sectionTotal;
    filledFields += sectionFilled;

    if (sectionFilled < sectionTotal) {
      fieldEntries
        .filter(([, v]) => !v)
        .forEach(([k]) => missingFields.push(k));
    }

    sections.push({
      key:        sectionKey,
      label:      section.label,
      total:      sectionTotal,
      filled:     sectionFilled,
      complete:   sectionFilled === sectionTotal,
      percentage: Math.round((sectionFilled / sectionTotal) * 100),
    });
  }

  const overallPercentage = Math.round((filledFields / totalFields) * 100);

  return {
    overallPercentage,
    isComplete:    overallPercentage === 100,
    filledFields,
    totalFields,
    sections,
    missingFields,
  };
};