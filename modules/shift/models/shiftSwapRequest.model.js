// modules/shift/models/shiftSwapRequest.model.js
//
// ShiftSwapRequest = Employee A requests to swap shifts with Employee B
// on a specific date.
//
// Flow:
//   Employee A → raises swap request (selects B + date)
//   Employee B → notified, accepts or declines
//   Manager    → gives final approval or rejection (if B accepts)
//   On approval → both employees' rosters/attendance are updated
//
// Dynamic design:
//   - approvalType is configurable — manager only, or B's acceptance followed by manager approval
//   - No shifts are hard-coded — the employees' shifts are resolved from their rosters
//   - comment mandatory on rejection (configurable in service)
//   - Full approvalHistory maintained (audit trail)
//
// Status flow:
//   PENDING_ACCEPTANCE  → B has not accepted or declined yet
//   PENDING_APPROVAL    → B accepted; awaiting the manager's decision
//   APPROVED            → Manager approved; rosters updated
//   REJECTED_BY_B       → B declined
//   REJECTED_BY_MANAGER → Manager rejected
//   CANCELLED           → A cancelled the request (before B acted)
//   EXPIRED             → The requested date passed without action

const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─── Approval Action Sub-Schema ──────────────────────────────
// Same pattern as leaveRequest.models.js → approvalActionSchema
const swapActionSchema = new Schema(
  {
    // "REQUESTER" | "REQUESTED_EMPLOYEE" | "MANAGER" | "HR"
    actorType: {
      type:     String,
      required: true,
    },

    actorId: {
      type:     Schema.Types.ObjectId,
      ref:      "User",
      required: true,
    },

    actorName: { type: String },
    actorRole: { type: String },

    action: {
      type:     String,
      enum:     ["RAISED", "ACCEPTED", "DECLINED", "APPROVED", "REJECTED", "CANCELLED"],
      required: true,
    },

    comment:  { type: String, trim: true, maxlength: 500 },
    actionAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// ─── Main Schema ─────────────────────────────────────────────
const shiftSwapRequestSchema = new Schema(
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

    // Employee requesting the swap
    requesterEmployeeId: {
      type:     Schema.Types.ObjectId,
      ref:      "Employee",
      required: true,
      index:    true,
    },

    requesterUserId: {
      type:     Schema.Types.ObjectId,
      ref:      "User",
      required: true,
    },

    // Employee asked to swap shifts
    requestedEmployeeId: {
      type:     Schema.Types.ObjectId,
      ref:      "Employee",
      required: true,
      index:    true,
    },

    requestedUserId: {
      type:     Schema.Types.ObjectId,
      ref:      "User",
      required: true,
    },

    // ─── Shift Details ─────────────────────────────────────
    // Swap date — for one day only (multi-day swaps require separate requests)
    swapDate: {
      type:     Date,
      required: [true, "swapDate is required"],
      index:    true,
      // The service validates that swapDate >= today
    },

    // Requester's shift on swapDate (resolved from the roster and saved)
    // Denormalized for display — may become stale if the roster changes
    // Service always re-checks roster on approval
    requesterShiftId: {
      type:    Schema.Types.ObjectId,
      ref:     "Shift",
      default: null,
      // null allowed — if the requester has no roster, use the default shift
    },

    requesterShiftName: {
      type:    String,
      default: null,
      // Snapshot at request time for display (e.g. "Morning Shift 09:00-18:00")
    },

    // Requested employee's shift on swapDate
    requestedShiftId: {
      type:    Schema.Types.ObjectId,
      ref:     "Shift",
      default: null,
    },

    requestedShiftName: {
      type:    String,
      default: null,
    },

    // ─── Reason ────────────────────────────────────────────
    reason: {
      type:      String,
      trim:      true,
      maxlength: 500,
      default:   "",
      // Optional — provides context for HR/the manager
    },

    // ─── Approval Config ───────────────────────────────────
    // Who needs to approve this swap?
    // "MANAGER_ONLY"       → only the manager approves or rejects
    // "EMPLOYEE_THEN_MANAGER" → B accepts first, then the manager decides
    // Set by service based on unit's attendance policy / company config
    approvalType: {
      type:    String,
      enum:    ["MANAGER_ONLY", "EMPLOYEE_THEN_MANAGER"],
      default: "EMPLOYEE_THEN_MANAGER",
    },

    // Manager who will approve (reporting manager of requester)
    managerId: {
      type:    Schema.Types.ObjectId,
      ref:     "User",
      default: null,
      // Resolved at request creation time from employee.reportingManagerId
      // Fallback: hr_manager of unit
    },

    // ─── Status ────────────────────────────────────────────
    status: {
      type:  String,
      enum:  [
        "PENDING_ACCEPTANCE",   // B has not responded yet
        "PENDING_APPROVAL",     // B accepted; awaiting the manager's decision
        "APPROVED",             // Swap complete, rosters updated
        "REJECTED_BY_B",        // B declined
        "REJECTED_BY_MANAGER",  // Manager rejected
        "CANCELLED",            // A cancelled the request
        "EXPIRED",              // swapDate has passed
      ],
      default: "PENDING_ACCEPTANCE",
      index:   true,
    },

    // ─── B's Response ──────────────────────────────────────
    bAcceptedAt:  { type: Date,   default: null },
    bDeclinedAt:  { type: Date,   default: null },
    bComment:     { type: String, trim: true, maxlength: 500, default: null },

    // ─── Manager's Response ────────────────────────────────
    managerActionAt: { type: Date,   default: null },
    managerComment:  { type: String, trim: true, maxlength: 500, default: null },

    // ─── Cancellation ──────────────────────────────────────
    cancelledAt:     { type: Date,   default: null },
    cancelledBy:     { type: Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500, default: null },

    // ─── Roster Update Tracking ────────────────────────────
    // On APPROVED — service updates both employees' rosters
    // Track whether roster was actually updated
    rosterUpdated: {
      type:    Boolean,
      default: false,
    },

    rosterUpdatedAt: {
      type:    Date,
      default: null,
    },

    // ─── Full Audit Trail ──────────────────────────────────
    // Every action logged here — same as leaveRequest approvalHistory
    actionHistory: {
      type:    [swapActionSchema],
      default: [],
    },

    // ─── Expiry ────────────────────────────────────────────
    // Auto-expire if no action taken before swapDate
    // Cron job sets status → EXPIRED
    expiresAt: {
      type:  Date,
      // Set to swapDate - 1 day at creation (configurable)
      // Ensures no pending swap on the day itself
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

// Is this request still actionable?
shiftSwapRequestSchema.virtual("isActionable").get(function () {
  return ["PENDING_ACCEPTANCE", "PENDING_APPROVAL"].includes(this.status);
});

// Is swap date in the past?
shiftSwapRequestSchema.virtual("isPast").get(function () {
  return this.swapDate && new Date(this.swapDate) < new Date();
});

// ─── Indexes ─────────────────────────────────────────────────

// Manager dashboard — pending approvals
shiftSwapRequestSchema.index({
  managerId:  1,
  status:     1,
  is_deleted: 1,
});

// Employee A — view their own requests
shiftSwapRequestSchema.index({
  requesterEmployeeId: 1,
  status:              1,
  is_deleted:          1,
});

// Employee B — requests received
shiftSwapRequestSchema.index({
  requestedEmployeeId: 1,
  status:              1,
  is_deleted:          1,
});

// Unit-level listing for HR
shiftSwapRequestSchema.index({
  unit_id:    1,
  swapDate:   1,
  is_deleted: 1,
});

// Expiry cron — find all pending requests past swapDate
shiftSwapRequestSchema.index({
  status:     1,
  expiresAt:  1,
  is_deleted: 1,
});

module.exports = mongoose.model("ShiftSwapRequest", shiftSwapRequestSchema);