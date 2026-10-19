// modules/attendance/models/attendance.model.js
//
// Attendance record — one record per employee per day.
//
// Punch flow:
//   Employee punches in  → checkIn set, status = PRESENT
//   Employee punches out → checkOut set, workingHours calculated
//
// Status values:
//   PRESENT        → Attended and punched in/out
//   ABSENT         → No record / HR manually marked absent
//   HALF_DAY       → Attended only half the day
//   ON_LEAVE       → Approved leave for that day
//   HOLIDAY        → Company/national holiday
//   WEEKEND        → Saturday/Sunday (or tenant's day off)
//   LATE           → Punched in late (after the grace period)
//   WFH            → Work from home
//
// workingHours:
//   checkOut - checkIn in decimal hours (e.g. 8.5 = 8 hrs 30 min)
//   Null if the employee has not punched out yet
//
// overtimeHours:
//   workingHours - standardHours (only if positive)
//   e.g. standardHours = 8, workingHours = 9.5 → overtime = 1.5

const mongoose = require("mongoose");
const { Schema } = mongoose;

const attendanceSchema = new Schema(
  {
    // ─── Scope Isolation ─────────────────────────────────────────
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    company_id: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    unit_id: {
      type: Schema.Types.ObjectId,
      ref: "Unit",
      required: true,
      index: true,
    },

    // ─── Employee Reference ──────────────────────────────────────
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ─── Date (date-only, time zeroed to midnight UTC) ────────────
    // Index + unique per employee per tenant per day enforced below
    date: {
      type: Date,
      required: true,
    },

    // ─── Status ──────────────────────────────────────────────────
    status: {
      type: String,
      enum: [
        "PRESENT",
        "ABSENT",
        "HALF_DAY",
        "ON_LEAVE",
        "HOLIDAY",
        "WEEKEND",
        "LATE",
        "WFH",
      ],
      default: "ABSENT",
      index: true,
    },

    // ─── Punch Times (stored as full Date with time) ──────────────
    checkIn: {
      type: Date,
      default: null,
    },

    checkOut: {
      type: Date,
      default: null,
    },

    // Daily record stays unique; each pair records an actual work interval.
    // Legacy records without sessions are interpreted as one interval.
    sessions: [{ checkIn: { type: Date, required: true }, checkOut: { type: Date, default: null } }],

    // ─── Calculated Fields ────────────────────────────────────────
    // Decimal hours — calculated on punch-out
    workingHours: {
      type: Number,
      default: null,
      min: 0,
    },

    // Standard working hours for tenant (copied at record creation)
    standardHours: {
      type: Number,
      default: 8,
    },

    // workingHours - standardHours (only positive values stored)
    overtimeHours: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─── Late Tracking ────────────────────────────────────────────
    isLate: {
      type: Boolean,
      default: false,
    },

    // Minutes late (only if isLate = true)
    lateMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ─── WFH ─────────────────────────────────────────────────────
    isWFH: {
      type: Boolean,
      default: false,
    },

    // ─── Geolocation for Punch In/Out ─────────────────────────────
    checkInLocation: {
      latitude:   { type: Number, default: null },
      longitude:  { type: Number, default: null },
      accuracy:   { type: Number, default: null },  // GPS accuracy in meters
      timestamp:  { type: Date, default: null },
      isValid:    { type: Boolean, default: null }, // Within unit radius?
      distance:   { type: Number, default: null },  // Distance from unit (meters)
      source:     { type: String, default: null },  // 'gps' | 'ip' | 'unit_default' | 'unknown'
      message:    { type: String, default: null },  // Location capture message
      city:       { type: String, default: null },   // City (from IP)
      region:     { type: String, default: null },  // Region/State (from IP)
    },

    checkOutLocation: {
      latitude:   { type: Number, default: null },
      longitude:  { type: Number, default: null },
      accuracy:   { type: Number, default: null },
      timestamp:  { type: Date, default: null },
      isValid:    { type: Boolean, default: null },
      distance:   { type: Number, default: null },
      source:     { type: String, default: null },
      message:    { type: String, default: null },
    },

    // ─── Punch Source (top-level for biometric integration) ────────
    punchSource: {
      type:    String,
      enum:    ['WEB', 'MOBILE', 'BIOMETRIC', 'BIOMETRIC_CLOSED', 'MANUAL', 'REGULARIZED', 'UNKNOWN'],
      default: 'UNKNOWN',
      index:   true
    },

    // ─── Leave Reference (if ON_LEAVE) ────────────────────────────────
    leaveRequestId: {
      type: Schema.Types.ObjectId,
      ref: "LeaveRequest",
      default: null,
    },

    // ─── Holiday Reference (if HOLIDAY) ──────────────────────────
    holidayId: {
      type: Schema.Types.ObjectId,
      ref: "HolidayCalendar",
      default: null,
    },

    // ─── Notes / Remarks ─────────────────────────────────────────
    // Note from HR or the system (e.g. "Regularized by HR", "Server downtime")
    remarks: {
      type: String,
      trim: true,
      maxlength: [500, "Remarks cannot exceed 500 characters."],
      default: null,
    },

    // ─── HR Regularization ────────────────────────────────────────
    // Did HR make a manual change? (audit trail)
    isRegularized: {
      type: Boolean,
      default: false,
    },

    regularizedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    regularizedAt: {
      type: Date,
      default: null,
    },

    // AT-09: every correction is logged so the employee / HR can see what changed and who did it
    regularizationLog: [{
      at:          { type: Date, default: Date.now },
      by:          { type: Schema.Types.ObjectId, ref: "User" },
      source:      { type: String, enum: ["ADMIN", "REQUEST"], default: "ADMIN" },
      type:        { type: String, default: null },     // MISSED_PUNCH_OUT, WRONG_TIME, …
      requestId:   { type: Schema.Types.ObjectId, default: null },
      remarks:     { type: String, default: null },
      before:      { status: String, checkIn: Date, checkOut: Date },
      after:       { status: String, checkIn: Date, checkOut: Date },
      _id: false,
    }],
    isLWP: { type: Boolean, default: false },

    // ─── Shift Info (future-proofing) ─────────────────────────────
    shiftStart: {
      type: String, // "09:00" format
      default: "09:00",
    },

    shiftEnd: {
      type: String, // "18:00" format
      default: "18:00",
    },

    // Night shift: shiftEnd is on next calendar day
    isNextDay: {
      type: Boolean,
      default: false,
    },

    // Grace period in minutes before marking LATE
    graceMinutes: {
      type: Number,
      default: 15,
    },

    // ─── Shift Resolution Metadata ─────────────────────────────────
    shiftId: {
      type: Schema.Types.ObjectId,
      ref: 'Shift',
      default: null
    },

    rosterId: {
      type: Schema.Types.ObjectId,
      ref: 'Roster',
      default: null
    },

    shiftSource: {
      type: String,
      enum: ['roster', 'default_shift', 'policy', 'policy_default'],
      default: 'policy_default'
    },

    halfDayThreshold: {
      type: Number,
      default: 4
    },

    overtimeThreshold: {
      type: Number,
      default: 0
    },

    // ─── Shift Finalization ────────────────────────────────────────
    finalized: {
      type: Boolean,
      default: false,
      index: true
    },

    finalizedAt: {
      type: Date,
      default: null
    },

    finalizedBy: {
      type: String,
      default: null // 'SYSTEM_CRON' | 'SYSTEM_AUTO_PUNCHOUT' | 'MANUAL' | userId
    },

    needsReview: {
      type: Boolean,
      default: false
    },

    reviewReason: {
      type: String,
      default: null
    },

    flaggedAt: {
      type: Date,
      default: null
    },

    // ─── Soft Delete ─────────────────────────────────────────────
    isDeleted: {
      type: Boolean,
      default: false,
      select: false,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Primary lookup: tenant + employee + date (unique — one record per day)
attendanceSchema.index(
  { org_id: 1, company_id: 1, unit_id: 1, employeeId: 1, date: 1 },
  { unique: true }
);

// Month-wise report query
attendanceSchema.index({ org_id: 1, company_id: 1, employeeId: 1, date: -1 });

// Status-based reporting
attendanceSchema.index({ org_id: 1, company_id: 1, status: 1, date: -1 });

// HR bulk view
attendanceSchema.index({ org_id: 1, company_id: 1, date: 1, status: 1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

// Human-readable working hours (e.g. "8h 30m")
attendanceSchema.virtual("workingHoursFormatted").get(function () {
  if (this.workingHours == null) return null;
  const h = Math.floor(this.workingHours);
  const m = Math.round((this.workingHours - h) * 60);
  return `${h}h ${m}m`;
});

// Is employee currently punched in (no checkout yet)?
attendanceSchema.virtual("isPunchedIn").get(function () {
  return !!this.checkIn && !this.checkOut;
});

// ─── Pre-save Hook: Validate and backfill workingHours ────────────────────────
// Mongoose 9.x: Use async function without next parameter

attendanceSchema.pre("save", async function () {
  // workingHours already calculated in service layer (timezone-aware)
  // This hook only validates the data
  if (this.checkIn && this.checkOut) {
    const diffMs = this.checkOut - this.checkIn;

    if (diffMs < 0) {
      throw new Error("Check-out time cannot be before check-in time");
    }

    // If workingHours not set, calculate (fallback)
    if (!this.workingHours) {
      this.workingHours = parseFloat((diffMs / (1000 * 60 * 60)).toFixed(2));
    }

    // overtimeHours is policy-driven and must be set by the service layer.
    // In particular, an explicit zero can mean OT is disabled or below threshold.
  }

  // Normalize the date to midnight (service layer should use org timezone midnight)
  // This is UTC midnight - service layer handles timezone conversion
//   if (this.date) {
//     const d = new Date(this.date);
//     d.setUTCHours(0, 0, 0, 0);
//     this.date = d;
//   }
  // if (this.date) {
  //   const d = new Date(this.date);
  //   d.setUTCHours(0, 0, 0, 0);
  //   this.date = d;
  // }

  // next();
});

// ─── Query Middleware: Soft delete filter ─────────────────────────────────────

attendanceSchema.pre(/^find/, function (next) {
  if (!this.getOptions().includeDeleted) {
    this.where({ isDeleted: false });
  }
  // next();
});

module.exports = mongoose.model("Attendance", attendanceSchema);