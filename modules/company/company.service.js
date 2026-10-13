// modules/company/company.service.js
// UPDATED — seedLeaveTypes added after company creation

const mongoose      = require("mongoose");
const bcrypt        = require("bcryptjs");
const Company       = require("./models/company.model");
const OrgModule     = require("../orgModule/models/orgModule.model");
const CompanyModule = require("./models/companyModule.model");
const Role          = require("../role/role.model");
const User          = require("../auth/models/user.model");
const AppError      = require("../../utils/appError");
const { sendEmail } = require("../../utils/email/email");
const { credentialsTemplate } = require("../../utils/email/templates/credentials");
const { seedLeaveTypes } = require("../../seeders/leave.Seeders");

// ─── Helpers ──────────────────────────────────────────────────
const generateCompanyCode = (name) => {
  const prefix = name.replace(/\s+/g, "").substring(0, 4).toUpperCase();
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${suffix}`;
};

const generateTempPassword = () => {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let pwd = "";
  for (let i = 0; i < 10; i++) pwd += chars[Math.floor(Math.random() * chars.length)];
  return pwd;
};

// ─── CREATE ───────────────────────────────────────────────────
exports.createCompany = async (payload, reqUser) => {
  const {
    company_name, company_email, company_phone,
    lobs = [],   // array of LOB names e.g. ["Technology", "Operations"]
    ...rest
  } = payload;
 
  // Duplicate company email check
  const existing = await Company.findOne({
    org_id:        reqUser.orgId,
    company_email: company_email.toLowerCase(),
    is_deleted:    false,
  });
  if (existing) throw new AppError("A company with this email already exists", 409);

  const existingName = await Company.findOne({
    org_id: reqUser.orgId,
    company_name: company_name.trim(),
    is_deleted: false,
  }).collation({ locale: "en", strength: 2 });
  if (existingName) throw new AppError("A company with this name already exists", 409);
 
  // Auto-generate unique company_code
  let company_code;
  let attempts = 0;
  do {
    company_code = generateCompanyCode(company_name);
    const taken = await Company.findOne({ company_code });
    if (!taken) break;
    attempts++;
  } while (attempts < 5);
 
  const session = await mongoose.startSession();
  session.startTransaction();
 
  let company;
 
  try {
    // STEP 1 — Create Company
    [company] = await Company.create([{
      org_id:        reqUser.orgId,
      company_code,
      company_name,
      company_email: company_email.toLowerCase(),
      company_phone,
      created_by:    reqUser.userId,
      ...rest,
    }], { session });
 
    // STEP 2 — Inherit active OrgModules → CompanyModule
    const orgModules = await OrgModule.find({
      org_id:    reqUser.orgId,
      is_active: true,
    }).lean();
 
    if (orgModules.length > 0) {
      const companyModuleDocs = orgModules.map((om) => ({
        org_id:     reqUser.orgId,
        company_id: company._id,
        module_id:  om.module_id,
        is_active:  true,
        created_by: reqUser.userId,
      }));
      await CompanyModule.insertMany(companyModuleDocs, { session, ordered: false });
    }
 
    // STEP 3 — Create LOBs if provided
    if (lobs.length > 0) {
      const LOB = require("../lob/models/lob.model");
      const lobDocs = lobs.map((lobName) => ({
        org_id:     reqUser.orgId,
        company_id: company._id,
        name:       lobName.trim(),
        created_by: reqUser.userId,
      }));
      await LOB.insertMany(lobDocs, { session, ordered: false });
    }
 
    await session.commitTransaction();
    session.endSession();
 
    // STEP 4 — Seed default leave types (outside transaction)
    try {
      await seedLeaveTypes(reqUser.orgId, company._id, reqUser.userId);
    } catch (leaveErr) {
      console.error("⚠️  Leave types seeding failed:", leaveErr.message);
    }
 
    return {
      company,
      lobsCreated: lobs.length,
      message: "Company created successfully.",
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
exports.getCompanies = async (reqUser, query = {}) => {
  const { status, search, page = 1, limit = 20 } = query;

  const filter = { org_id: reqUser.orgId, is_deleted: false };

  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { company_name:  { $regex: search, $options: "i" } },
      { company_email: { $regex: search, $options: "i" } },
      { company_code:  { $regex: search, $options: "i" } },
    ];
  }

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await Company.countDocuments(filter);
  const companies = await Company.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .populate('admin', 'name email status') // ✅ Populate admin field
    .lean();

const companiesWithAdmin = companies.map(c => ({
  ...c,
  admin: c.admin || null, // ✅ Single admin reference
}));

return {
  companies: companiesWithAdmin,
  pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
};
};

// ─── GET ONE ──────────────────────────────────────────────────
exports.getCompanyById = async (companyId, reqUser) => {
  const filter = { _id: companyId, org_id: reqUser.orgId, is_deleted: false };

  // Company Admin/HR sirf apni company dekh sakta hai
  if (["company_admin", "company_hr_manager"].includes(reqUser.role)) {
    filter._id = reqUser.companyId;
  }

  const company = await Company.findOne(filter);
  if (!company) throw new AppError("Company not found", 404);
  return company;
};

// ─── UPDATE ───────────────────────────────────────────────────
exports.updateCompany = async (companyId, payload, reqUser) => {
  // Protected fields — cannot be changed after creation
  const restricted = ["org_id", "company_code", "company_email", "is_deleted"];
  restricted.forEach(f => delete payload[f]);

  // T-07 — Allowed statutory + profile fields
  // cin, tan, pt_state, brand_name, registered_address,
  // correspondence_address, gst, pan, epfo, esic, address,
  // company_name, company_phone, logo_url, company_size,
  // working_hours, year_type, leave_policy, pay_schedule

  const company = await Company.findOneAndUpdate(
    { _id: companyId, org_id: reqUser.orgId, is_deleted: false },
    { ...payload, updatedBy: reqUser.userId },
    { new: true, runValidators: true }
  );
  if (!company) throw new AppError("Company not found", 404);
  return company;
};

// ─── SOFT DELETE ──────────────────────────────────────────────
exports.deleteCompany = async (companyId, reqUser) => {
  const company = await Company.findOne({
    _id: companyId, org_id: reqUser.orgId, is_deleted: false,
  });
  if (!company) throw new AppError("Company not found", 404);

  // Employee check add karo
  const Employee = require("../employee/models/employee.model");
  const activeEmployees = await Employee.countDocuments({
    company_id: companyId,
    isDeleted:  false,
  });

  if (activeEmployees > 0) {
    throw new AppError(
      `Cannot delete — ${activeEmployees} employee(s) linked to this company.`,
      400
    );
  }

  const activeUsers = await User.countDocuments({
    company_id: companyId,
    isDeleted:  false,
    status:     "ACTIVE",
  });

  if (activeUsers > 1) {
    throw new AppError(
      `Cannot delete — ${activeUsers - 1} active user(s) linked to this company.`,
      400
    );
  }

  company.is_deleted = true;
  company.status     = "Inactive";
  await company.save();

  return { message: "Company deleted successfully" };
};