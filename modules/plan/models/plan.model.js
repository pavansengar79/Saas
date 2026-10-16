// modules/plan/plan.model.js

const mongoose = require("mongoose");

const planSchema = new mongoose.Schema(
  {
    name: {
      type:     String,
      required: [true, "Plan name is required"],
      trim:     true,
    },

    package_type: {
      type:     String,
      enum:     ["professionals", "teams", "enterprise"],
      required: [true, "Package type is required"],
    },

    structure_level: {
      type:     String,
      enum:     ["unit", "company", "enterprise"],
      required: true,
    },

    price_monthly: {
      type:    Number,
      default: null,
    },

    price_annual: {
      type:    Number,
      default: null,
    },

    seat_limit: {
      type:    Number,
      default: null,
    },

    // ← ObjectId refs instead of slugs
    modules: [{
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Module",
    }],

    // ─── Feature Gates ────────────────────────────────────────
    // Features included in this plan
    // Manage through the Super Admin UI — no code deployment needed
    // e.g. ["shift_roster", "bulk_import_export", "leave_encashment"]
    // checkFeature.middleware.js checks these features
    features: {
      type:    [String],
      default: [],
      // Available feature keys — same as config/featureGates.js keys
      // ["shift_roster", "bulk_import_export", "leave_encashment",
      //  "sandwich_rule", "leave_liability_report", "custom_roles",
      //  "horizontal_delegation", "delegation_approval_flow",
      //  "payslip_pdf_download", "saml_sso", "ip_allowlisting",
      //  "session_activity_log", "biometric_integration",
      //  "bu_site_structure", "bu_independent_payroll", "advanced_reports"]
    },

    status: {
      type:    String,
      enum:    ["Draft", "Active", "Deprecated"],
      default: "Draft",
    },

    is_custom: {
      type:    Boolean,
      default: false,
    },

    is_public: {
      type:    Boolean,
      default: false,
    },

    version: {
      type:    Number,
      default: 1,
    },

    created_by: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },

    is_deleted: {
      type:    Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

planSchema.index({ status: 1, is_public: 1 });
planSchema.index({ package_type: 1 });

module.exports = mongoose.model("Plan", planSchema);