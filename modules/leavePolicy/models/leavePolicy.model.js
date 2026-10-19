// modules/leavePolicy/models/leavePolicy.model.js
// UPDATED — tenantId → org_id + company_id + unit_id

const mongoose = require("mongoose");

// --- Sub-Schema: Carry Forward Rules -----------------------------------------
const carryForwardSchema = new mongoose.Schema(
  {
    allowed:        { type: Boolean, default: false },
    max:            { type: Number, default: 0, min: 0 },
    expiryDays:     { type: Number, default: 90, min: 0 },
    expiryAction:   { type: String, enum: ["LAPSE", "ENCASH"], default: "LAPSE" },
    carryForwardOn: { type: String, default: "YEAR_END" },
  },
  { _id: false }
);

// --- Sub-Schema: Encashment Rules --------------------------------------------
const encashmentSchema = new mongoose.Schema(
  {
    allowed:      { type: Boolean, default: false },
    maxDays:      { type: Number, default: 0, min: 0 },
    minBalance:   { type: Number, default: 0, min: 0 },
    applicableAt: { type: [String], enum: ["YEAR_END", "RESIGNATION", "ANYTIME"], default: ["YEAR_END"] },
    taxable:      { type: Boolean, default: true },
  },
  { _id: false }
);

// --- Sub-Schema: Application Rules -------------------------------------------
const applicationRuleSchema = new mongoose.Schema(
  {
    minDays:                    { type: Number, default: 0.5, min: 0.5 },
    maxDays:                    { type: Number, default: null },
    maxPerMonth:                { type: Number, default: null },
    advanceNoticeDays:          { type: Number, default: 0, min: 0 },
    allowBackdated:             { type: Boolean, default: false },
    backdatedAllowedDays:       { type: Number, default: 0 },
    allowHalfDay:               { type: Boolean, default: true },
    allowContinuousWithHoliday: { type: Boolean, default: true },
    requireReasonMinLength:     { type: Number, default: 10 },
    cooldownDays:               { type: Number, default: 0 },
  },
  { _id: false }
);

// --- Sub-Schema: Document Rules ----------------------------------------------
const documentRuleSchema = new mongoose.Schema(
  {
    required:     { type: Boolean, default: false },
    afterDays:    { type: Number, default: null },
    allowedTypes: { type: [String], default: ["pdf", "jpg", "jpeg", "png"] },
  },
  { _id: false }
);

// --- Sub-Schema: Approval Flow -----------------------------------------------
const approvalFlowSchema = new mongoose.Schema(
  {
    type:                  { type: String, enum: ["AUTO", "L1", "L1_L2"], default: "L1_L2" },
    levels:                { type: [String], default: ["Reporting Manager", "HR Manager"] },
    autoApproveAfterHours: { type: Number, default: null },
  },
  { _id: false }
);

// --- Sub-Schema: Credit Rules ------------------------------------------------
const creditSchema = new mongoose.Schema(
  {
    totalPerYear:        { type: Number, required: true, min: 0 },
    frequency:           { type: String, enum: ["NONE", "MONTHLY", "QUARTERLY", "YEARLY"], default: "YEARLY" },
    perCycle:            { type: Number, default: 0, min: 0 },
    accrualType:         { type: String, enum: ["NONE", "MONTHLY", "QUARTERLY", "YEARLY"], default: "YEARLY" },
    accrualDay:          { type: Number, default: 1, min: 1, max: 31 },
    roundingRule:        { type: String, enum: ["FLOOR", "CEIL", "ROUND"], default: "ROUND" },
    probationApplicable: { type: Boolean, default: false },
  },
  { _id: false }
);

// --- Sub-Schema: Balance Rules -----------------------------------------------
const balanceSchema = new mongoose.Schema(
  {
    maxBalance:    { type: Number, default: null },
    allowNegative: { type: Boolean, default: false },
    maxNegative:   { type: Number, default: 0 },
    resetCycle:    { type: String, enum: ["YEARLY", "FISCAL_YEAR", "NEVER"], default: "YEARLY" },
  },
  { _id: false }
);

// --- Sub-Schema: Individual Leave Type Entry ---------------------------------
const leavePolicyTypeSchema = new mongoose.Schema(
  {
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "LeaveType", default: null },

    name:        { type: String, required: true, trim: true, maxlength: 100 },
    code:        { type: String, required: true, trim: true, uppercase: true, maxlength: 10 },
    description: { type: String, trim: true, maxlength: 500 },
    isPaid:      { type: Boolean, default: true },
    isPublic:    { type: Boolean, default: true },
    color: {
      type:    String,
      default: "#4F46E5",
      match:   [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, "Invalid color hex"],
    },

    credit:  { type: creditSchema,  required: true, default: () => ({ totalPerYear: 0 }) },
    balance: { type: balanceSchema, default: () => ({}) },

    genderRestriction: {
      type:    String,
      enum:    ["ALL", "MALE", "FEMALE", "OTHER"],
      default: "ALL",
    },
    minTenureMonths: { type: Number, default: 0, min: 0 },
    applicableEmploymentTypes: {
      type:    [String],
      enum:    ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"],
      default: ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"],
    },
    cooldownDays: { type: Number, default: 0 },

    sandwichRule: {
      override:        { type: Boolean, default: false },
      enabled:         { type: Boolean, default: false },
      includeHolidays: { type: Boolean, default: true },
      includeWeekends: { type: Boolean, default: true },
    },

    carryForward: { type: carryForwardSchema,     default: () => ({}) },
    encashment:   { type: encashmentSchema,        default: () => ({}) },
    application:  { type: applicationRuleSchema,  default: () => ({}) },
    approvalFlow: { type: approvalFlowSchema,      default: () => ({}) },
    documentRule: { type: documentRuleSchema,      default: () => ({}) },

    isActive:  { type: Boolean, default: true },
    sortOrder: { type: Number,  default: 0 },
  },
  { _id: true }
);

// --- Main LeavePolicy Schema -------------------------------------------------
const leavePolicySchema = new mongoose.Schema(
  {
    // ── Scope Fields ──────────────────────────────────────
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
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Unit",
      default: null,
    },

    // ── Policy Fields ─────────────────────────────────────
    name:          { type: String, required: true, trim: true, maxlength: 150 },
    description:   { type: String, trim: true, maxlength: 1000 },
    effectiveFrom: { type: Date, required: true },
    effectiveTo:   { type: Date, default: null },

    status: {
      type:    String,
      enum:    ["draft", "active", "inactive", "archived"],
      default: "draft",
      index:   true,
    },

    version: { type: Number, default: 1, min: 1 },

    applicableFor: {
      departments:     [{ type: mongoose.Schema.Types.ObjectId, ref: "Department" }],
      designations:    [{ type: mongoose.Schema.Types.ObjectId, ref: "Designation" }],
      roles:           [{ type: String }],
      locations:       [{ type: String, trim: true }],
      employmentTypes: {
        type: [String],
        enum: ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"],
      },
    },

    sandwichRule: {
      enabled:                    { type: Boolean, default: false },
      includeHolidays:            { type: Boolean, default: true },
      includeWeekends:            { type: Boolean, default: true },
      consecutiveLeaveThreshold:  { type: Number,  default: 2 },
    },

    leaveTypes: {
      type:    [leavePolicyTypeSchema],
      default: [],
      validate: {
        validator: function (types) {
          const codes = types.map((t) => t.code);
          return codes.length === new Set(codes).size;
        },
        message: "Duplicate leave type codes found in policy",
      },
    },

    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    activatedAt: { type: Date, default: null },
    archivedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    archivedAt:  { type: Date, default: null },

    isDeleted: { type: Boolean, default: false, select: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

// --- Indexes -----------------------------------------------------------------
leavePolicySchema.index({ company_id: 1, status: 1, isDeleted: 1 });
leavePolicySchema.index({ company_id: 1, effectiveFrom: 1, effectiveTo: 1 });
leavePolicySchema.index({ company_id: 1, "applicableFor.departments": 1 });
leavePolicySchema.index({ company_id: 1, "applicableFor.designations": 1 });
leavePolicySchema.index({ unit_id: 1, "applicableFor.roles": 1 });

// --- Virtuals ----------------------------------------------------------------
leavePolicySchema.virtual("isActive").get(function () {
  return this.status === "active";
});

leavePolicySchema.virtual("totalLeaveTypesCount").get(function () {
  return this.leaveTypes?.length || 0;
});

leavePolicySchema.virtual("activeLeaveTypes").get(function () {
  return this.leaveTypes?.filter((t) => t.isActive) || [];
});

// --- Pre-save Hook -----------------------------------------------------------
// Mongoose 9 passes no `next` to pre hooks — throw to fail the save
leavePolicySchema.pre("save", function () {
  if (this.effectiveTo && this.effectiveTo <= this.effectiveFrom) {
    throw new Error("effectiveTo must be after effectiveFrom");
  }
  // next();
});

// --- Query Middleware --------------------------------------------------------
leavePolicySchema.pre(/^find/, function (next) {
  if (!this.getOptions().includeDeleted) {
    this.where({ isDeleted: false });
  }
});

// --- Static Methods ----------------------------------------------------------
leavePolicySchema.statics.getActivePolicies = function (company_id, unit_id) {
  const filter = {
    company_id,
    status:    "active",
    isDeleted: false,
    effectiveFrom: { $lte: new Date() },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: new Date() } }],
  };
  if (unit_id) filter.unit_id = unit_id;
  return this.find(filter);
};

module.exports = mongoose.model("LeavePolicy", leavePolicySchema);