// modules/subscription/subscription.model.js
//
// Task 4 — NEW
//
// Subscription = the purchase record linking an Organization to a Plan.
// One active subscription per org at any time.
//
// Why plan_snapshot exists:
//   If Super Admin edits a Plan (changes price or modules),
//   existing customers must NOT be affected.
//   We store a copy of the plan at purchase time in plan_snapshot.
//   All permission/module checks use plan_snapshot — never the live Plan doc.
//
// Status flow:
//   Trial → Active (on payment)
//   Active → PastDue (payment fails)
//   PastDue → Active (payment recovers) OR Expired (grace period ends)
//   Active/Trial → Cancelled (customer cancels)
//
// grace_ends_at:
//   Set to 7 days after payment failure.
//   During grace period: system still works but user sees warning.
//   After grace: status → Expired, access blocked.

const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    // ─── Links ────────────────────────────────────────────────
    org_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: [true, "org_id is required"],
      index: true,
    },

    plan_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Plan",
      default: null,
      // null = trial with no paid plan selected yet
    },

    // ─── Plan Snapshot ────────────────────────────────────────
    // Copy of plan fields at time of purchase.
    // Checked for module access — never the live Plan document.
    // Stays unchanged even if Super Admin edits the Plan later.
    plan_snapshot: {
      name:          { type: String },
      price_monthly: { type: Number },
      price_annual:  { type: Number },
      seat_limit:    { type: Number, default: null },
      modules:       { type: [String], default: [] },
      structure_level: { type: String, default: null },
      package_type:    { type: String, default: null },

      // Module slugs — e.g. ["employee", "attendance", "leave", "payroll"]
      // e.g. ["employee", "attendance", "leave", "payroll", "auth"]

      // ─── Feature Gates snapshot ───────────────────────────
      // Copy of plan.features[] at purchase time
      // checkFeature.middleware.js checks this, not the live plan
      // If the Super Admin updates the plan, existing customers are unaffected
      features: { type: [String], default: [] },
    },

    // ─── Status ───────────────────────────────────────────────
    status: {
      type: String,
      enum: ["Trial", "Active", "PastDue", "Cancelled", "Expired"],
      default: "Trial",
    },

    // ─── Billing ──────────────────────────────────────────────
    billing_cycle: {
      type: String,
      enum: ["monthly", "annual"],
      default: "monthly",
    },

    seats_purchased: {
      type: Number,
      default: null, // null = unlimited (Enterprise)
    },

    // ─── Dates ────────────────────────────────────────────────
    starts_at: {
      type: Date,
      default: Date.now,
    },

    // Trial: 14 days from starts_at
    // Paid: set based on billing_cycle (monthly = +30d, annual = +365d)
    ends_at: {
      type: Date,
      default: () => new Date(+new Date() + 14 * 24 * 60 * 60 * 1000),
    },

    // Set when payment fails — 7 days from failure date
    // System stays live during this window but user sees upgrade warning
    grace_ends_at: {
      type: Date,
      default: null,
    },

    // Set when customer explicitly cancels
    cancelled_at: {
      type: Date,
      default: null,
    },

    // ─── Flags ────────────────────────────────────────────────
    // Quick filter — false when Cancelled or Expired
    is_active: {
      type: Boolean,
      default: true,
    },

    // ─── Trial Extension Tracking ───────────────────────────────
    // Running total of days granted via approved TrialExtensionRequest
    // docs (see modules/subscription/models/trialExtensionRequest.model.js).
    // Capped at MAX_TRIAL_EXTENSION_DAYS in subscription.service.js —
    // this field is what that cap is checked against, so a customer
    // can't keep requesting +5 days forever.
    trial_extension_days_used: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────
// Most common query: find active subscription by org
subscriptionSchema.index({ org_id: 1, is_active: 1 });
subscriptionSchema.index({ status: 1 });

module.exports = mongoose.model("Subscription", subscriptionSchema);