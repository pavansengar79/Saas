// modules/shift/models/roster.model.js
//
// Roster = an employee's shift assignment for a date range.
//
// How it works:
//   - HR creates a roster entry assigning Rahul to the Night Shift from June 1 to June 30.
//   - On punch-in, attendance.service.js checks:
//       1. Does this employee have an active roster for today?
//       2. If so, use that shift's startTime.
//       3. Otherwise, use the unit's isDefault:true shift.
//       4. If there is no default shift, fall back to AttendancePolicy's workingHours.
//
// Multiple rosters can exist for one employee (different date ranges).
// Overlapping date ranges: checked by the service layer on creation.
//
// Active roster query:
//   Roster.findOne({
//     employee_id,
//     unit_id,
//     startDate: { $lte: today },
//     endDate:   { $gte: today },
//     is_deleted: false
//   }).populate("shift_id")

const mongoose = require("mongoose");
const { Schema } = mongoose;

const rosterSchema = new Schema(
  {
    // ─── Scope ───────────────────────────────────────────────
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

    // ─── Assignment ──────────────────────────────────────────
    employee_id: {
      type:     Schema.Types.ObjectId,
      ref:      "Employee",
      required: true,
      index:    true,
    },

    shift_id: {
      type:     Schema.Types.ObjectId,
      ref:      "Shift",
      required: true,
    },

    // ─── Date Range ──────────────────────────────────────────
    // Both stored as Date at midnight UTC for consistent comparison
    startDate: {
      type:     Date,
      required: [true, "startDate is required"],
    },

    endDate: {
      type:     Date,
      required: [true, "endDate is required"],
      // Validated in service: endDate >= startDate
    },

    // ─── Notes ───────────────────────────────────────────────
    notes: {
      type:    String,
      trim:    true,
      default: "",
      // e.g. "Project deadline coverage", "Client site deployment"
    },

    // ─── Status ──────────────────────────────────────────────
    // ACTIVE   = currently in effect
    // ENDED    = endDate has passed (can be set by cron or on-query)
    // REVOKED  = manually cancelled before endDate
    status: {
      type:    String,
      enum:    ["ACTIVE", "ENDED", "REVOKED"],
      default: "ACTIVE",
    },

    revokedBy: {
      type:    Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },

    revokedAt: {
      type:    Date,
      default: null,
    },

    is_deleted: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    // ─── Audit ───────────────────────────────────────────────
    createdBy: {
      type: Schema.Types.ObjectId,
      ref:  "User",
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref:  "User",
    },
  },
  { timestamps: true }
);

// ─── Indexes ─────────────────────────────────────────────────

// PRIMARY — attendance.service.js uses this on every punch-in
// "Does this employee have an active roster for today?"
rosterSchema.index({
  employee_id: 1,
  unit_id:     1,
  startDate:   1,
  endDate:     1,
  is_deleted:  1,
});

// Calendar view — HR can see each employee's shift assignments for the month
rosterSchema.index({
  unit_id:    1,
  startDate:  1,
  endDate:    1,
  is_deleted: 1,
});

// Employee can view their own roster
rosterSchema.index({ employee_id: 1, status: 1, is_deleted: 1 });

module.exports = mongoose.model("Roster", rosterSchema);