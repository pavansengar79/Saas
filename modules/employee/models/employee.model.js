// modules/employee/models/employee.model.js
//
// UPDATED — tenantId removed
// Now uses org_id + company_id + unit_id for multi-tenant scope
//
// Scope:
//   org_id     → required — which org this employee belongs to
//   company_id → required — which company
//   unit_id    → required — which unit (employees always belong to a unit)
//   lob_id     → optional — for reference/reporting

const mongoose = require("mongoose");
const { Schema } = mongoose;

const employeeSchema = new mongoose.Schema({

  // ─── Scope Fields ─────────────────────────────────
  org_id: {
    type:     Schema.Types.ObjectId,
    ref:      "Organization",
    required: true,
    index:    true
  },

  company_id: {
    type:     Schema.Types.ObjectId,
    ref:      "Company",
    required: true,
    index:    true
  },

  unit_id: {
    type:     Schema.Types.ObjectId,
    ref:      "Unit",
    required: true,
    index:    true
  },

  lob_id: {
    type:    Schema.Types.ObjectId,
    ref:     "LOB",
    default: null
  },

  userId: {
    type:    Schema.Types.ObjectId,
    ref:     "User",
    default: null
  },

  employeeId: {
    type:     String,
    required: true
  },

  // ─── Biometric Integration ───────────────────────────────────────────────
  // Device-scoped numeric code for biometric attendance
  // Generated lazily when first pushed to a device
  // Immutable once assigned - treated as system secret
  biometricCode: {
    type:     Number,
    default:  null,
    index:    true
  },

  // RFID card number (if applicable)
  rfidCardNumber: {
    type:     String,
    default:  null
  },

  // ─── Personal Info ────────────────────────────────────────────────────────
  name: {
    type:     String,
    required: true,
    trim:     true
  },

  email: {
    type:      String,
    required:  true,
    lowercase: true,
    trim:      true
  },

  phone: {
    type:     String,
    required: true
  },

  alternatePhone: { type: String },
  dateOfBirth:    { type: Date },
  // P0-6: false for employees who are not EPS members (e.g. joined after
  // Sep 2014 with basic above the wage ceiling). EPS also stops at age 58.
  epsEligible:    { type: Boolean, default: true },

  gender: {
    type: String,
    enum: ["MALE", "FEMALE", "OTHER"]
  },

  bloodGroup: {
    type: String,
    enum: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]
  },

  maritalStatus: {
    type: String,
    enum: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"]
  },
about: {
  type:      String,
  default:   null,
  trim:      true,
  maxlength: 500,
},
  profilePhoto: { type: String },

  // ─── Address ──────────────────────────────────────
  currentAddress: {
    street:  { type: String },
    city:    { type: String },
    state:   { type: String },
    stateCode: { type: String, uppercase: true, default: null },
    country: { type: String },
    countryCode: { type: String, uppercase: true, default: null },
    pincode: { type: String }
  },

  permanentAddress: {
    street:  { type: String },
    city:    { type: String },
    state:   { type: String },
    stateCode: { type: String, uppercase: true, default: null },
    country: { type: String },
    countryCode: { type: String, uppercase: true, default: null },
    pincode: { type: String }
  },

  // ─── Normalized Location for Policy Matching ──────
  // Used by payroll/attendance/leave policy resolution
  location: {
    city:       { type: String, trim: true, default: null },
    state:      { type: String, trim: true, default: null },
    stateCode:  { type: String, uppercase: true, default: null },
    country:    { type: String, trim: true, default: null },
    countryCode:{ type: String, uppercase: true, default: null }
  },

  // ─── Job Info ─────────────────────────────────────
  departmentId: {
    type:     Schema.Types.ObjectId,
    ref:      "Department",
    required: true
  },

  designationId: {
    type: Schema.Types.ObjectId,
    ref:  "Designation"
  },

  reportingManagerId: {
    type:    Schema.Types.ObjectId,
    ref:     "Employee",
    default: null
  },

  employmentType: {
    type:    String,
    enum:    ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"],
    default: "FULL_TIME"
  },

  joiningDate:      { type: Date, required: true },
  confirmationDate: { type: Date },
  exitDate:         { type: Date },
  exitReason:       { type: String },

  status: {
    type:    String,
    enum:    ["ACTIVE", "INACTIVE", "ON_NOTICE", "TERMINATED", "ON_LEAVE"],
    default: "INACTIVE"
  },

  // ─── Salary Structure ─────────────────────────────
  salary: {
    basic:            { type: Number, required: true },
    hra:              { type: Number, default: 0 },
    travelAllowance:  { type: Number, default: 0 },
    medicalAllowance: { type: Number, default: 0 },
    specialAllowance: { type: Number, default: 0 },

    // ─── Dynamic Salary Components ─────────────────────────
    // Companies can add unlimited custom components:
    // Food Allowance, Night Shift, Internet, Telephone, etc.
    // code must be unique per employee salary structure
    customComponents: [{
      code:     { type: String, required: true, uppercase: true, trim: true },
      name:     { type: String, required: true, trim: true },
      amount:   { type: Number, default: 0, min: 0 },
      taxable:  { type: Boolean, default: true },
      pfApplicable:  { type: Boolean, default: false },
      esiApplicable: { type: Boolean, default: false },
    }],

    pf:               { type: Number, default: 0 },
    esi:              { type: Number, default: 0 },
    tds:              { type: Number, default: 0 },
    grossSalary:      { type: Number, default: 0 },
    netSalary:        { type: Number, default: 0 },
    currency:         { type: String, default: "INR" },
    effectiveFrom:    { type: Date }
  },

  // ─── Bank Details ─────────────────────────────────
  bankDetails: {
    accountNumber: { type: String },
    ifscCode:      { type: String },
    bankName:      { type: String },
    branchName:    { type: String },
    accountType: {
      type:    String,
      enum:    ["SAVINGS", "CURRENT"],
      default: "SAVINGS"
    }
  },

  // ─── Emergency Contact ────────────────────────────
  emergencyContact: {
    name:     { type: String },
    phone:    { type: String },
    relation: { type: String }
  },
  // ─── Education ─────────────────────────────────────────────────────────────
  education: [{
    institution: { type: String, trim: true },
    degree:      { type: String, trim: true },
    from:        { type: Date },
    to:          { type: Date }
  }],

  // ─── Work Experience ───────────────────────────────────────────────────────
  experience: [{
    company: { type: String, trim: true },
    role:    { type: String, trim: true },
    from:    { type: Date },
    to:      { type: Date },
    current: { type: Boolean, default: false }
  }],

  // ─── Family Details ───────────────────────────────────────────────────────
  familyDetails: [{
    name:        { type: String, trim: true },
    relation:    { type: String, trim: true },
    dateOfBirth: { type: Date },
    phone:       { type: String }
  }],
  // ─── Meta ─────────────────────────────────────────
  isDeleted: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User" }

}, { timestamps: true });

// ─── Indexes ──────────────────────────────────────────
// EmployeeId must be unique within org + company + unit scope
employeeSchema.index({ org_id: 1, company_id: 1, unit_id: 1, employeeId: 1 }, { unique: true });
employeeSchema.index({ org_id: 1, company_id: 1, email: 1 },      { unique: true });
employeeSchema.index({ org_id: 1, company_id: 1, status: 1 });
employeeSchema.index({ unit_id: 1, isDeleted: 1 });
employeeSchema.index({ company_id: 1, departmentId: 1 });
employeeSchema.index({ 'location.stateCode': 1 });
employeeSchema.index({ 'location.city': 1 });

// ─── Pre-save Hook: Auto-populate location from currentAddress ────────
employeeSchema.pre('save', async function() {
  // Normalize location from currentAddress for policy matching
  if (this.currentAddress) {
    this.location = {
      city:        this.currentAddress.city || null,
      state:       this.currentAddress.state || null,
      stateCode:   this.currentAddress.stateCode || null,
      country:     this.currentAddress.country || null,
      countryCode: this.currentAddress.countryCode || null
    }
  }
  // No next() needed for async hooks
})

module.exports = mongoose.model("Employee", employeeSchema);