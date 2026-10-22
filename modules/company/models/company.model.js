// modules/company/models/company.model.js
//
// RENAMED from tenant.models.js → company.model.js
//
// Company = a business entity under an Organization.
// e.g. "Tata Steel", "Tata Motors" are companies under "Tata Group" org.
//
// Hierarchy:
//   Organization → Company → LOB → Unit → Department
//
// What moved OUT of this model:
//   - plan, trialEndsAt, isTrialExpired → moved to Subscription model
//   - tenantCode → company_code (auto-generated)
//
// What was ADDED:
//   - org_id       → links to Organization
//   - gst, pan, epfo, esic → statutory compliance fields
//
// Config fields KEPT (workingHours, leavePolicy, paySchedule etc.)
// These are company-level HR defaults — still needed here.

const mongoose = require("mongoose");
const { normalizeCompanyName } = require("../companyName");

const companySchema = new mongoose.Schema(
  {
    // ─── Parent Org ───────────────────────────────────────────
    org_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: [true, "org_id is required"],
      index: true,
    },

    // ─── Identity ─────────────────────────────────────────────
    // Auto-generated on create — e.g. "TATA-001"
    company_code: {
      type: String,
      required: true,
      unique: true,
    },

    company_name: {
      type: String,
      required: true,
      trim: true,
      validate: { validator: (name) => Boolean(name?.trim()), message: "Company name cannot be blank" },
    },

    company_name_key: {
      type: String,
      select: false,
    },

    company_email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [/^[^.]/, "Company email cannot start with a dot"],
    },

    company_phone: {
      type: String,
      required: true,
      maxlength: 13,
      match: /^[0-9]{1,13}$/,
    },

    phone_country_code: {
      type: String,
      uppercase: true,
      match: /^[A-Z]{2}$/,
    },

    logo_url: {
      type: String,
      default: null,
    },

    // ─── Statutory & Compliance ───────────────────────────────
    gst: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    pan: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    epfo: {
      type: String,
      trim: true,
      default: null,
    },

    esic: {
      type: String,
      trim: true,
      default: null,
    },

    // T-07 — Additional statutory fields
    cin: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    tan: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },

    pt_state: {
      type: String,
      trim: true,
      default: null,
    },

    brand_name: {
      type: String,
      trim: true,
      default: null,
    },

    // Industry type
    industry: {
      type: String,
      trim: true,
      default: null,
    },

    // Alias fields for frontend compatibility
    pf_registration: {
      type: String,
      trim: true,
      default: null,
    },

    esic_registration: {
      type: String,
      trim: true,
      default: null,
    },

    // ─── Address ──────────────────────────────────────────────
    address: {
      country: { type: String },
      state:   { type: String },
      city:    { type: String },
      pincode: { type: String },
    },

    // T-07 — Registered address (detailed)
    registered_address: {
      street:  { type: String, trim: true, default: null },
      city:    { type: String, trim: true, default: null },
      state:   { type: String, trim: true, default: null },
      pincode: { type: String, trim: true, default: null },
      country: { type: String, trim: true, default: "India" },
    },

    // T-07 — Correspondence address
    correspondence_address: {
      type:    String,
      trim:    true,
      default: null,
    },

    // ─── Company Size ─────────────────────────────────────────
    company_size: {
      type: String,
      enum: ["1-10", "11-50", "51-200", "201-500", "500+"],
      default: null,
    },

    // ─── Working Hours Config ─────────────────────────────────
    working_hours: {
      start_time: { type: String, default: "09:00" },
      end_time:   { type: String, default: "18:00" },
      working_days: {
        type: [String],
        enum: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
        default: ["MON", "TUE", "WED", "THU", "FRI"],
      },
      saturday_type: {
        type: String,
        enum: ["NONE", "FULL", "ALTERNATE_ODD", "ALTERNATE_EVEN"],
        default: "NONE",
      },
    },

    // ─── Financial Year ───────────────────────────────────────
    year_type: {
      type: String,
      enum: ["CALENDAR", "FINANCIAL"],
      default: "CALENDAR",
    },

    // ─── Leave Defaults ───────────────────────────────────────
    leave_policy: {
      annual_leave: { type: Number, default: 12 },
      sick_leave:   { type: Number, default: 6 },
      casual_leave: { type: Number, default: 6 },
    },

    // ─── Payroll Config ───────────────────────────────────────
    pay_schedule: {
      type: String,
      enum: ["WEEKLY", "BIWEEKLY", "MONTHLY"],
      default: "MONTHLY",
    },

    // ─── Onboarding ───────────────────────────────────────────
    onboarding_step: {
      type: Number,
      default: 1,
    },

    is_onboarding_complete: {
      type: Boolean,
      default: false,
    },

    // ─── Status ───────────────────────────────────────────────
    status: {
      type: String,
      enum: ["Active", "Suspended", "Inactive"],
      default: "Active",
    },

    // ─── Soft Delete ──────────────────────────────────────────
    is_deleted: {
      type: Boolean,
      default: false,
    },

    // ─── Responsible Person (Admin) ──────────────────────────
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ─── Meta ─────────────────────────────────────────────────
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────
companySchema.index({ org_id: 1, is_deleted: 1 });
companySchema.index({ status: 1, is_deleted: 1 });
companySchema.index(
  { org_id: 1, company_name_key: 1 },
  {
    unique: true,
    name: "unique_active_company_name_per_org",
    partialFilterExpression: { is_deleted: false, company_name_key: { $type: "string" } },
  }
);

companySchema.pre("validate", function () {
  if (typeof this.company_name === "string") {
    this.company_name_key = normalizeCompanyName(this.company_name);
  }
});

module.exports = mongoose.model("Company", companySchema);