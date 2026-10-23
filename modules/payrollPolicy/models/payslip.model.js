// modules/payrollPolicy/models/payslip.model.js
// T-29 — Payslip model
// Generated after each payroll run for each employee

"use strict";

const mongoose = require("mongoose");

const earningsSchema = new mongoose.Schema({
  basic:            { type: Number, default: 0 },
  hra:              { type: Number, default: 0 },
  travelAllowance:  { type: Number, default: 0 },
  medicalAllowance: { type: Number, default: 0 },
  specialAllowance: { type: Number, default: 0 },
  overtime:         { type: Number, default: 0 },
  bonus:            { type: Number, default: 0 },
  arrears:          { type: Number, default: 0 },

  // Dynamic custom components — persisted in payslip for audit trail
  customComponents: [{
    code:          { type: String },
    name:          { type: String },
    amount:        { type: Number, default: 0 },
    taxable:       { type: Boolean, default: true },
    pfApplicable:  { type: Boolean, default: false },
    esiApplicable: { type: Boolean, default: false },
    _id:           false,
  }],
}, { _id: false });

const deductionsSchema = new mongoose.Schema({
  pf:              { type: Number, default: 0 },
  esi:             { type: Number, default: 0 },
  tds:             { type: Number, default: 0 },
  lop:             { type: Number, default: 0 }, // Loss of Pay deduction
  professionalTax: { type: Number, default: 0 },
  advance:         { type: Number, default: 0 },
  other:           { type: Number, default: 0 },
}, { _id: false });

const pfBreakupSchema = new mongoose.Schema({
  eps:   { type: Number, default: 0 },  // 8.33% of wages up to ceiling (Pension)
  epf:   { type: Number, default: 0 },  // employer PF minus EPS
  edli:  { type: Number, default: 0 },  // 0.5% of wages up to ceiling
  admin: { type: Number, default: 0 },  // 0.5% EPF admin charges
}, { _id: false });

const employerContributionsSchema = new mongoose.Schema({
  pf:       { type: Number, default: 0 },
  pfBreakup: { type: pfBreakupSchema, default: () => ({}) },
  esi:      { type: Number, default: 0 },
  gratuity: { type: Number, default: 0 },
}, { _id: false });

const payslipSchema = new mongoose.Schema({
  // ── Scope ──────────────────────────────────────────────────
  org_id: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "Organization",
    required: true,
    index:    true,
  },
  company_id: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "Company",
    required: true,
    index:    true,
  },
  unit_id: {
    type:  mongoose.Schema.Types.ObjectId,
    ref:   "Unit",
    index: true,
  },
  employee_id: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "Employee",
    required: true,
    index:    true,
  },

  // ── Period ─────────────────────────────────────────────────
  month: { type: Number, required: true, min: 1, max: 12 },
  year:  { type: Number, required: true },

  // ── Salary components ──────────────────────────────────────
  earnings:   { type: earningsSchema, default: () => ({}) },
  deductions: { type: deductionsSchema, default: () => ({}) },
  employerContributions: { type: employerContributionsSchema, default: () => ({}) },

  grossSalary: { type: Number, required: true, min: 0 },
  grossAfterLOP:  { type: Number, default: 0, min: 0 },       // post-LOP, before tax/PF

  netSalary:   { type: Number, required: true, min: 0 },

  // ── Attendance summary (for LOP) ───────────────────────────
  calculatedThrough: { type: Date },
  actualPayableDays: { type: Number },
  eligibleCalendarDays: { type: Number },
  totalWorkingDays:  { type: Number, default: 0 },
  eligibleWorkingDays: { type: Number, default: 0 },
  daysPresent:       { type: Number, default: 0 },
  lopDays:           { type: Number, default: 0 },
  daysPayable:       { type: Number },
  overtimeHours:     { type: Number, default: 0 },
  
  // LOP calculation details (for transparency in payslip)
  lopPerDayRate:     { type: Number, default: 0 },  // Actual per-day rate used for LOP deduction
  lopFormulaUsed:    { type: String, default: '' }, // Formula applied (e.g. 'monthly_salary/calendar_days')
  lopFormulaDays:    { type: Number, default: 0 },
  lopEnabled:        { type: Boolean, default: true }, // false = policy had LOP off; absences were not deducted  // Days divisor used (e.g. 31 for calendar_days, 23 for working_days)
  
  // Overtime calculation details
  overtimeRate:      { type: Number, default: 0 },  // Hourly rate for overtime
  overtimeMultiplier: { type: Number, default: 1.5 }, // Multiplier applied (e.g. 1.5x, 2x)

  // ── Tax Information (Enterprise) ────────────────────────────
  taxRegime: {
    type:    String,
    enum:    ["old", "new"],
    default: "new",
  },
  
  taxBreakdown: {
    taxableIncome:   { type: Number, default: 0 },
    grossTax:        { type: Number, default: 0 },
    rebate87A:       { type: Number, default: 0 },
    surcharge:       { type: Number, default: 0 },
    cess:            { type: Number, default: 0 },
    totalTax:         { type: Number, default: 0 },
    projectedAnnualGross: { type: Number, default: 0 },
    remainingMonths:  { type: Number, default: 0 },
    priorTDS:         { type: Number, default: 0 },
    isExitMonth:      { type: Boolean, default: false },   // PF-5
  },
  
  investmentSummary: {
    declarationId:    { type: mongoose.Schema.Types.ObjectId, ref: 'InvestmentDeclaration' },
    totalDeclared:    { type: Number, default: 0 },
    totalApproved:    { type: Number, default: 0 },
    sections:         [{
      section:          { type: String },
      declaredAmount:   { type: Number, default: 0 },
      approvedAmount:   { type: Number, default: 0 },
      _id:              false,
    }],
  },

  // ── Year-to-Date (YTD) Fields ───────────────────────────────
  ytd: {
    earnings: {
      basic:            { type: Number, default: 0 },
      hra:              { type: Number, default: 0 },
      travelAllowance:  { type: Number, default: 0 },
      medicalAllowance: { type: Number, default: 0 },
      specialAllowance: { type: Number, default: 0 },
      overtime:         { type: Number, default: 0 },
      bonus:            { type: Number, default: 0 },
      arrears:          { type: Number, default: 0 },
      customComponentsTotal: { type: Number, default: 0 },   // PF-1
      totalEarnings:    { type: Number, default: 0 },
    },
    deductions: {
      pf:               { type: Number, default: 0 },
      esi:              { type: Number, default: 0 },
      tds:              { type: Number, default: 0 },
      professionalTax:  { type: Number, default: 0 },
      lop:              { type: Number, default: 0 },
      totalDeductions:  { type: Number, default: 0 },
    },
  },

  // ── Status ─────────────────────────────────────────────────
  status: {
    type:    String,
    enum:    ["DRAFT", "PUBLISHED", "PAID"],
    default: "DRAFT",
    index:   true,
  },

  // ── Payment ────────────────────────────────────────────────
  paymentDate: { type: Date, default: null },
  paymentMode: {
    type:    String,
    enum:    ["BANK_TRANSFER", "CHEQUE", "CASH", null],
    default: null,
  },
  transactionRef: { type: String, default: null },

  // ── Audit ──────────────────────────────────────────────────
  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  approvedAt:  { type: Date, default: null },
  isDeleted:   { type: Boolean, default: false },

  // ── Revisions (P0-7) — status stays PUBLISHED/PAID so the employee still sees it
  isRevised:     { type: Boolean, default: false },
  revisionCount: { type: Number, default: 0 },
  revisionHistory: [{
    revisedAt:        { type: Date, default: Date.now },
    revisedBy:        { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reason:           { type: String, required: true },
    statusAtRevision: { type: String },
    oldValues:        { type: mongoose.Schema.Types.Mixed },
    newValues:        { type: mongoose.Schema.Types.Mixed },
    _id: false,
  }],
},
{
  timestamps: true,
  toJSON: { virtuals: true },
});

// ── Indexes ──────────────────────────────────────────────────
payslipSchema.index({ company_id: 1, month: 1, year: 1 });
payslipSchema.index({ employee_id: 1, year: 1, month: 1 }, { unique: true });
payslipSchema.index({ company_id: 1, status: 1 });

// ── Virtual: period label ─────────────────────────────────────
payslipSchema.virtual("period").get(function () {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[this.month - 1]} ${this.year}`;
});

module.exports = mongoose.model("Payslip", payslipSchema);