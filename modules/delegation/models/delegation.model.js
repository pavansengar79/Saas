// modules/delegation/models/delegation.model.js
//
// Delegation lets a user temporarily grant specific permissions
// to another user.
//
// Real world example:
//   Rahul (Manager) is going on leave for two weeks.
//   He grants Priya "leave.approve" and "attendance.approve"
//   permissions temporarily from Jun 15 to Jun 30.
//   Priya's own role does not have these permissions, but during
//   this period the permission middleware checks active delegations.
//
// Dynamic design:
//   - Any permission within the role's scope can be delegated.
//   - startDate and endDate are configurable; no minimum or maximum is hardcoded.
//   - approvalRequired: true may require approval from a manager or HR,
//     depending on the organization's configuration.
//   - maxDelegationDays comes from company configuration, not this model.
//   - A user can grant and receive multiple delegations at once.
//   - The same permission can be delegated to the same person only once
//     at a time (enforced by the service layer).
//
// How the permission middleware checks delegations in layer 3:
//   if (!roleHasPermission) {
//     const delegation = await Delegation.findOne({
//       delegatee_id: req.user.userId,
//       permissions:  { $in: [permission._id] },
//       status:       "ACTIVE",
//       startDate:    { $lte: now },
//       endDate:      { $gte: now },
//       is_deleted:   false,
//     });
//     if (delegation) return next();
//   }
//
// Status flow:
//   PENDING  → waiting for approval when approvalRequired is true
//   ACTIVE   → in effect from startDate
//   EXPIRED  → endDate has passed (set by the scheduled job)
//   REVOKED  → withdrawn by the delegator before endDate
//   REJECTED → rejected by the approver

const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─── Action History Sub-Schema ───────────────────────────────
// Log every change, as with leave requests and shift swaps.
const delegationActionSchema = new Schema(
  {
    // "DELEGATOR" | "APPROVER" | "SYSTEM"
    actorType: {
      type:     String,
      required: true,
    },

    actorId: {
      type:     Schema.Types.ObjectId,
      ref:      "User",
      required: true,
    },

    actorName: { type: String, default: null },
    actorRole: { type: String, default: null },

    action: {
      type:     String,
      enum:     ["CREATED", "APPROVED", "REJECTED", "REVOKED", "EXPIRED", "MODIFIED"],
      required: true,
    },

    comment:  { type: String, trim: true, maxlength: 500, default: null },
    actionAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// ─── Main Schema ─────────────────────────────────────────────
const delegationSchema = new Schema(
  {
    // ─── Scope ─────────────────────────────────────────────
    org_id: {
      type:     Schema.Types.ObjectId,
      ref:      "Organization",
      required: true,
      index:    true,
    },

    company_id: {
      type:     Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
      index:    true,
    },

    unit_id: {
      type:     Schema.Types.ObjectId,
      ref:      "Unit",
      required: true,
      index:    true,
    },

    // ─── Parties ───────────────────────────────────────────

    // User granting the permissions
    delegator_id: {
      type:     Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },

    // User receiving the permissions
    delegatee_id: {
      type:     Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },

    // ─── Permissions ───────────────────────────────────────
    // Specific permissions being delegated
    // Array of Permission ObjectIds
    // The service validates:
    //   1. Permission exists + is_active
    //   2. The delegator's role has the permission.
    //      Users can delegate only their own permissions.
    //   3. The permission's scope is within the delegator's level.
    permissions: {
      type:     [Schema.Types.ObjectId],
      ref:      "Permission",
      required: [true, "At least one permission is required"],
      validate: {
        validator: (arr) => arr && arr.length > 0,
        message:   "permissions array cannot be empty",
      },
    },

    // Denormalized slugs for quick display (e.g. ["leave.approve", "attendance.approve"])
    // Set at creation time, not updated later
    permissionSlugs: {
      type:    [String],
      default: [],
    },

    // ─── Duration ──────────────────────────────────────────
    startDate: {
      type:     Date,
      required: [true, "startDate is required"],
      // Service validate: startDate >= today
    },

    endDate: {
      type:     Date,
      required: [true, "endDate is required"],
      // Service validate: endDate > startDate
      // Service also checks vs maxDelegationDays from company config
    },

    // ─── Reason ────────────────────────────────────────────
    reason: {
      type:      String,
      required:  [true, "Reason for delegation is required"],
      trim:      true,
      minlength: [5,   "Reason must be at least 5 characters"],
      maxlength: [500, "Reason cannot exceed 500 characters"],
      // e.g. "Going on annual leave Jun 15-30, Priya will handle approvals"
    },

    // ─── Approval (optional) ───────────────────────────────
    // If company config has requireDelegationApproval: true,
    // a manager or HR above the delegator must approve it.
    // By default approval is not required, so the delegation activates immediately.
    approvalRequired: {
      type:    Boolean,
      default: false,
    },

    // Who needs to approve this delegation
    // Resolved from delegator's reportingManagerId or unit hr_manager
    approverId: {
      type:    Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },

    approvedAt:     { type: Date,   default: null },
    approvedBy:     { type: Schema.Types.ObjectId, ref: "User", default: null },
    rejectedAt:     { type: Date,   default: null },
    rejectedBy:     { type: Schema.Types.ObjectId, ref: "User", default: null },
    rejectionReason:{ type: String, trim: true, maxlength: 500, default: null },

    // ─── Status ────────────────────────────────────────────
    status: {
      type:  String,
      enum:  [
        "PENDING",   // approvalRequired:true, waiting for approver
        "ACTIVE",    // in effect — permission.middleware checks this
        "EXPIRED",   // endDate has passed; the scheduled job sets this.
        "REVOKED",   // manually withdrawn by the delegator
        "REJECTED",  // rejected by the approver
      ],
      default: "ACTIVE", // ACTIVE by default because approvalRequired defaults to false.
      index:   true,
    },

    // ─── Revocation ────────────────────────────────────────
    revokedAt:      { type: Date,   default: null },
    revokedBy:      { type: Schema.Types.ObjectId, ref: "User", default: null },
    revocationReason: { type: String, trim: true, maxlength: 500, default: null },

    // ─── Notification Tracking ─────────────────────────────
    // Whether an email was sent to the recipient
    notifiedAt: {
      type:    Date,
      default: null,
    },

    // Expiry reminder sent (1 day before endDate)
    expiryReminderSentAt: {
      type:    Date,
      default: null,
    },

    // ─── Full Audit Trail ──────────────────────────────────
    actionHistory: {
      type:    [delegationActionSchema],
      default: [],
    },

    // ─── Meta ──────────────────────────────────────────────
    is_deleted: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref:  "User",
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref:  "User",
    },
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Virtuals ────────────────────────────────────────────────

// Is delegation currently in effect?
delegationSchema.virtual("isInEffect").get(function () {
  if (this.status !== "ACTIVE") return false;
  const now = new Date();
  return now >= this.startDate && now <= this.endDate;
});

// Days remaining
delegationSchema.virtual("daysRemaining").get(function () {
  if (this.status !== "ACTIVE") return 0;
  const diff = new Date(this.endDate) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
});

// ─── Indexes ─────────────────────────────────────────────────

// CRITICAL — the permission middleware uses this index in layer 3.
// Check whether the recipient has an active delegation for this permission.
delegationSchema.index({
  delegatee_id: 1,
  permissions:  1,
  status:       1,
  startDate:    1,
  endDate:      1,
  is_deleted:   1,
});

// Delegator — permissions granted by this user
delegationSchema.index({
  delegator_id: 1,
  status:       1,
  is_deleted:   1,
});

// Approver dashboard — pending delegations for approval
delegationSchema.index({
  approverId:   1,
  status:       1,
  is_deleted:   1,
});

// Scheduled job — expire delegations whose endDate has passed.
delegationSchema.index({
  status:     1,
  endDate:    1,
  is_deleted: 1,
});

// Unit-level HR view
delegationSchema.index({
  unit_id:    1,
  status:     1,
  is_deleted: 1,
});

module.exports = mongoose.model("Delegation", delegationSchema);