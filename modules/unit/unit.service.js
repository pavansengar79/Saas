// modules/unit/unit.service.js

const mongoose      = require("mongoose");
const bcrypt        = require("bcryptjs");
const Unit          = require("./models/unit.model");
const LOB           = require("../lob/models/lob.model");
const Role          = require("../role/role.model");
const User          = require("../auth/models/user.model");
const Employee      = require("../employee/models/employee.model");
const Department    = require("../department/department.model");
const Designation   = require("../designation/designation.model");
const AppError      = require("../../utils/appError");
const { sendEmail } = require("../../utils/email/email");
const inviteTemplate = require("../../utils/email/templates/inviteEmail");

// ─── Helper ───────────────────────────────────────────────────
const generateTempPassword = () => {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let pwd = "";
  for (let i = 0; i < 10; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  return pwd;
};

// ─── Scope guard ──────────────────────────────────────────────
const verifyLobScope = async (lob_id, reqUser) => {
  const filter = { _id: lob_id, org_id: reqUser.orgId, is_deleted: false };
  if (reqUser.level === "company") filter.company_id = reqUser.companyId;

  const lob = await LOB.findOne(filter);
  if (!lob) throw new AppError("LOB not found or access denied", 404);
  return lob;
};

// ─── CREATE ───────────────────────────────────────────────────
// Flow:
//   1. Create the Unit
//   2. Create the Unit Admin user (is_first_login: true)
//   3. Create the Employee record (for HRMS operations: attendance, leave, payroll)
//   4. Email the credentials
// All in one DB transaction. Email is outside transaction.
//
// admin_email is separate from the unit — it is the Unit Admin's email
// (different from LOB/Company email)
exports.createUnit = async (payload, reqUser) => {
  const {
    lob_id, name, description, location,
    geolocation, locationSettings,
    admin_name, admin_email, admin_phone
  } = payload;
 
  const lob = await verifyLobScope(lob_id, reqUser);
 
  // Duplicate unit name check within same LOB
  const existing = await Unit.findOne({
    lob_id,
    name:       { $regex: `^${name}$`, $options: "i" },
    is_deleted: false,
  });
  if (existing) throw new AppError("A unit with this name already exists in this LOB", 409);
 
  // Check if admin_email already exists
  if (admin_email) {
    const existingUser = await User.findOne({
      email: admin_email,
      org_id: reqUser.orgId,
      is_deleted: false,
    });
    if (existingUser) {
      throw new AppError("A user with this admin email already exists", 409);
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();
 
  try {
    // 1. Create Unit
    const [unit] = await Unit.create([{
      org_id:      reqUser.orgId,
      company_id:  lob.company_id,
      lob_id,
      name,
      description: description || "",
      location:    location    || null,
      // Geolocation fields
      ...(geolocation && {
        geolocation: {
          latitude: geolocation.latitude || null,
          longitude: geolocation.longitude || null,
          radiusMeters: geolocation.radiusMeters || 200,
          address: geolocation.address || {}
        }
      }),
      // Location settings
      locationSettings: {
        geoFencingEnabled: locationSettings?.geoFencingEnabled || false,
        allowOutsidePunch: locationSettings?.allowOutsidePunch || false,
        requireExactMatch: locationSettings?.requireExactMatch || false
      },
      created_by:  reqUser.userId,
    }], { session });

    let adminUser = null;
    let adminEmployee = null;
    let tempPassword = null;

    // 2. Create Unit Admin User & Employee (if admin details provided)
    if (admin_email && admin_name) {
      // Get unit_admin role
      const unitAdminRole = await Role.findOne({
        slug: "unit_admin",
        $or: [
          { org_id: reqUser.orgId },
          { org_id: null, isSystem: true }
        ]
      }).session(session);

      if (!unitAdminRole) {
        throw new AppError("Unit Admin role not found. Please run seeders first.", 500);
      }

      // Generate temporary password
      tempPassword = generateTempPassword();
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      // Create User
      const [createdUser] = await User.create([{
        name: admin_name,
        email: admin_email,
        phone: admin_phone || null,
        password: hashedPassword,
        roleId: unitAdminRole._id,
        org_id: reqUser.orgId,
        company_id: lob.company_id,
        unit_id: unit._id,
        status: "ACTIVE",
        is_first_login: true,
        isEmailVerified: true,
        createdBy: reqUser.userId,
      }], { session });

      adminUser = createdUser;

      // 3. Create Employee record for Unit Admin
      // Find or create "Administration" or "HR" department
      let department = await Department.findOne({
        company_id: lob.company_id,
        org_id: reqUser.orgId,
        unit_id: unit._id,
        name: { $regex: "^(Administration|HR|Admin)$", $options: "i" },
        isDeleted: false,
      }).session(session);

      if (!department) {
        // Create Administration department
        const [createdDept] = await Department.create([{
          name: "Administration",
          company_id: lob.company_id,
          org_id: reqUser.orgId,
          unit_id: unit._id,
          status: "active",
          created_by: reqUser.userId,
        }], { session });
        department = createdDept;
      }

      // Find or create "Unit Admin" designation
      let designation = await Designation.findOne({
        company_id: lob.company_id,
        org_id: reqUser.orgId,
        unit_id: unit._id,
        name: { $regex: "^(Unit Admin|Admin|Manager)$", $options: "i" },
        isDeleted: false,
      }).session(session);

      if (!designation) {
        // Create Unit Admin designation
        const [createdDesig] = await Designation.create([{
          name: "Unit Admin",
          company_id: lob.company_id,
          org_id: reqUser.orgId,
          unit_id: unit._id,
          status: "active",
          created_by: reqUser.userId,
        }], { session });
        designation = createdDesig;
      }

      // Generate employee ID
      const employeeCount = await Employee.countDocuments({
        org_id: reqUser.orgId,
        company_id: lob.company_id,
      }).session(session);
      const employeeId = `EMP${String(employeeCount + 1).padStart(5, "0")}`;

      // Create Employee record
      const [createdEmployee] = await Employee.create([{
        org_id: reqUser.orgId,
        company_id: lob.company_id,
        unit_id: unit._id,
        lob_id: lob._id,
        userId: adminUser._id,
        employeeId,
        name: admin_name,
        email: admin_email,
        phone: admin_phone || "0000000000", // Default phone if not provided
        departmentId: department._id,
        designationId: designation._id,
        employmentType: "FULL_TIME",
        joiningDate: new Date(),
        status: "ACTIVE",
        salary: {
          basic: 0,
          hra: 0,
          grossSalary: 0,
          netSalary: 0,
        },
      }], { session });

      adminEmployee = createdEmployee;
    }
 
    await session.commitTransaction();
    session.endSession();
 
    // Fresh query — avoid circular JSON from session
    const createdUnit = await Unit.findById(unit._id).lean();

    // Send email with credentials (outside transaction)
    if (adminUser && tempPassword) {
      const Company = require("../company/models/company.model");
      const company = await Company.findById(lob.company_id).select("company_name").lean();
      
      await sendEmail({
        to: admin_email,
        subject: "Your HRMS Unit Admin Account Has Been Created 🚀",
        html: inviteTemplate({
          name: admin_name,
          companyName: company?.company_name || "HRMS",
          roleName: "Unit Admin",
          departmentName: "Administration",
          email: admin_email,
          tempPassword,
        }),
      });
    }
 
    return {
      unit: createdUnit,
      admin: adminUser ? {
        id: adminUser._id,
        name: adminUser.name,
        email: adminUser.email,
        employeeId: adminEmployee?.employeeId,
      } : null,
      message: adminUser 
        ? "Unit created successfully. Admin credentials sent via email."
        : "Unit created successfully.",
    };
 
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || "field";
      throw new AppError(`Duplicate value for ${field}. Please try again.`, 409);
    }
    throw err;
  }
};

// ─── GET ALL ──────────────────────────────────────────────────
exports.getUnits = async (reqUser, query = {}) => {
  const { lob_id, company_id, status, search, page = 1, limit = 20 } = query;

  const filter = { org_id: reqUser.orgId, is_deleted: false };

  if (reqUser.level === "company") filter.company_id = reqUser.companyId;
  else if (company_id)            filter.company_id  = company_id;

  if (lob_id) filter.lob_id = lob_id;
  if (status) filter.status = status;
  if (search) filter.name   = { $regex: search, $options: "i" };

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await Unit.countDocuments(filter);
  const units = await Unit.find(filter)
    .populate("lob_id",     "name")
    .populate("company_id", "company_name company_code")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  // ─── Populate admin (unit_admin) for each unit ───────────────────────────────
  const unitIds = units.map(u => u._id);
  const unitAdminRole = await Role.findOne({ slug: "unit_admin" }).select("_id").lean();
  
  const admins = unitAdminRole ? await User.find({
    org_id:     reqUser.orgId,
    unit_id:    { $in: unitIds },
    roleId:     unitAdminRole._id,
    status:     "ACTIVE",
    is_deleted: false,
  }).select("name email unit_id status").lean() : [];

  // Multiple active admins per unit are allowed — group into an array
  // instead of keeping only the last match.
  const adminsByUnit = {};
  admins.forEach(a => {
    const key = String(a.unit_id);
    if (!adminsByUnit[key]) adminsByUnit[key] = [];
    adminsByUnit[key].push(a);
  });

  const unitsWithAdmin = units.map(u => ({
    ...u,
    admins: adminsByUnit[String(u._id)] || [],
  }));

  return {
    units: unitsWithAdmin,
    pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
  };
};

// ─── GET ONE ──────────────────────────────────────────────────
exports.getUnitById = async (unitId, reqUser) => {
  const filter = { _id: unitId, org_id: reqUser.orgId, is_deleted: false };
  if (reqUser.level === "company") filter.company_id = reqUser.companyId;

  const unit = await Unit.findOne(filter)
    .populate("lob_id",     "name")
    .populate("company_id", "company_name");
  if (!unit) throw new AppError("Unit not found", 404);
  return unit;
};

// ─── UPDATE ───────────────────────────────────────────────────
exports.updateUnit = async (unitId, payload, reqUser) => {
  // Prevent changing scope fields
  delete payload.org_id;
  delete payload.company_id;
  delete payload.lob_id;

  const filter = { _id: unitId, org_id: reqUser.orgId, is_deleted: false };
  if (reqUser.level === "company") filter.company_id = reqUser.companyId;

  const unit = await Unit.findOneAndUpdate(filter, payload, { new: true, runValidators: true });
  if (!unit) throw new AppError("Unit not found", 404);
  return unit;
};

// ─── SOFT DELETE ──────────────────────────────────────────────
// Block if active employees are linked
exports.deleteUnit = async (unitId, reqUser) => {
  const filter = { _id: unitId, org_id: reqUser.orgId, is_deleted: false };
  if (reqUser.level === "company") filter.company_id = reqUser.companyId;

  const unit = await Unit.findOne(filter);
  if (!unit) throw new AppError("Unit not found", 404);

  // Block if active employees exist (lazy require — Phase 2)
  let activeEmployees = 0;
  try {
    const Employee = require("../employee/models/employee.model");
    activeEmployees = await Employee.countDocuments({
      unit_id:   unitId,
  isDeleted: false,   // ← correct field name
    });
  } catch (_) {}

  if (activeEmployees > 0) {
    throw new AppError(
      `Cannot delete unit — ${activeEmployees} active employee(s) assigned. Reassign them first.`,
      400
    );
  }

  unit.is_deleted = true;
  unit.status     = "Inactive";
  await unit.save();

  return { message: "Unit deleted successfully" };
};