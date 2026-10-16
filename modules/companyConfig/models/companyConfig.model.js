// modules/companyConfig/models/companyConfig.model.js
// UPDATED — tenantId → company_id (company-level config)

const mongoose = require("mongoose");

const companyConfigSchema = new mongoose.Schema(
  {
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
      unique:   true,
      index:    true,
    },

    // PAN is required for TDS calculations
    pan: {
      type: String,
      trim: true,
      uppercase: true,
      match: [/^[A-Z]{5}\d{4}[A-Z]{1}$/, 'Invalid PAN format. Example: AADCM4321B'],
    },

    fiscalYearStart: { type: Number, min: 1, max: 12, default: 4 },
    timezone:        { type: String, default: "Asia/Kolkata", trim: true },
    currency:        { type: String, default: "INR", uppercase: true, trim: true, maxlength: 3 },

    dateFormat: {
      type:    String,
      enum:    ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"],
      default: "DD/MM/YYYY",
    },

    workWeek: {
      type:    [String],
      enum:    ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
      default: ["MON", "TUE", "WED", "THU", "FRI"],
    },

    defaultWorkingHoursPerDay: { type: Number, default: 8, min: 1, max: 24 },
    payrollCutoffDay:          { type: Number, default: 25, min: 1, max: 28 },
    salaryDay:                 { type: Number, default: 1, min: 1, max: 28 },
    workingDaysPerWeek:        { type: Number, enum: [5, 6], default: 5 },
    standardHoursPerDay:       { type: Number, default: 8, min: 1, max: 24 },
    overtimeThresholdHours:    { type: Number, default: 9, min: 1, max: 24 },
    lateThresholdMinutes:      { type: Number, default: 15, min: 0, max: 120 },
    halfDayThresholdHours:     { type: Number, default: 4, min: 1, max: 12 },

    // T-08 — Regularisation settings
    regularisationWindowDays: { type: Number, default: 30, min: 1, max: 90 },
    defaultFallbackShift:     { type: String, default: null, trim: true },

    // T-08 — Security settings
    mfaEnforcementLevel: {
      type:    String,
      enum:    ["NONE", "OPTIONAL", "MANDATORY"],
      default: "OPTIONAL",
    },
    sessionTimeoutMinutes: { type: Number, default: 480, min: 5, max: 10080 },
    loginMaxAttempts:      { type: Number, default: 5,   min: 3, max: 20 },
    loginLockoutMinutes:   { type: Number, default: 30,  min: 5, max: 1440 },

    // T-08 — OAuth toggles
    googleOAuthEnabled:    { type: Boolean, default: false },
    microsoftOAuthEnabled: { type: Boolean, default: false },
    regularisationWindowDays: { type: Number, default: 30, min: 1, max: 90 },

// NEW — Flexible approval flow
regularisationApprovalFlow: {
  type:    String,
  enum:    ["L1_ONLY", "L2_ONLY", "L1_L2", "AUTO"],
  default: "L2_ONLY",  // PM default — directly to HR
},

    // T-08 — SMTP configuration (per-company outgoing mail)
    smtp: {
      host:    { type: String, trim: true, default: null },
      port:    { type: Number, default: 587 },
      user:    { type: String, trim: true, default: null },
      pass:    { type: String, select: false, default: null },
      from:    { type: String, trim: true, default: null },
      secure:  { type: Boolean, default: false },
    },

    // T-08 — Google Maps API key (for location-based attendance)
    googleMapsApiKey: { type: String, trim: true, select: false, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CompanyConfig", companyConfigSchema);