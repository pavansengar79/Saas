const mongoose = require("mongoose");

// ─── Sub-Schema: Shift ────────────────────────────────────────────────────────
// Spec: name, start (HH:MM), end (HH:MM), graceMinutes, minimumHours, halfDayMinHours
const shiftSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,                        // e.g. "Morning Shift", "General Shift"
    },
    start: {
      type: String,
      required: true,
      match: [/^([01]\d|2[0-3]):[0-5]\d$/, "start must be HH:MM format"],
    },
    end: {
      type: String,
      required: true,
      match: [/^([01]\d|2[0-3]):[0-5]\d$/, "end must be HH:MM format"],
    },
    
    // ─── Night Shift Flag ───────────────────────────────
    // true = shift crosses midnight (end time is next day)
    // e.g., 21:00 → 05:00 means shift starts at 9 PM, ends at 5 AM next day
    isNextDay: {
      type: Boolean,
      default: false,
    },
    
    graceMinutes: {
      type: Number,
      default: 10,
      min: 0,
      max: 60,                               // grace period after shift start before marking late
    },
    minimumHours: {
      type: Number,
      default: 8,
      min: 1,
      max: 24,                               // minimum hours to count as full day present
    },
    halfDayMinHours: {
      type: Number,
      default: 4,
      min: 0.5,                              // minimum hours to count as half day
    },
    
    // ─── Shift Window Controls (Enterprise HRMS) ─────────────────
    // Control when punch-in is allowed
    strictPunchWindow: {
      type: Boolean,
      default: true,                         // If true, enforce shift start/end limits
    },
    // Allow punch-in after shift end (with time limit)
    allowLatePunchIn: {
      type: Boolean,
      default: false,                        // If true, allow late punch-in up to maxLateMinutes
    },
    // Maximum minutes after shift end for punch-in (only if allowLatePunchIn=true)
    maxLateMinutes: {
      type: Number,
      default: 120,                          // 2 hours after shift start by default
      min: 15,
      max: 480,                              // max 8 hours
    },
    // Allow punch-in before shift start (minutes before)
    allowEarlyMinutes: {
      type: Number,
      default: 30,                           // Allow punch 30 min early
      min: 0,
      max: 120,
    },
  },
  { _id: false }
);

// ─── Sub-Schema: Late Mark ────────────────────────────────────────────────────
// Spec: enabled, countAfterMinutes, penalty{type, value}, allowedPerMonth, escalationAfter
const lateMarkSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },

    countAfterMinutes: {
      type: Number,
      default: 15,
      min: 0,                                // minutes beyond grace — then it counts as a late mark
    },

    penalty: {
      type: {
        type: String,
        enum: ["leave", "salary"],
        default: "leave",                    // deduct from leave balance OR salary
      },
      value: {
        type: Number,
        enum: [0.5, 1],
        default: 0.5,                        // 0.5 = half day deduction, 1 = full day
      },
    },

    allowedPerMonth: {
      type: Number,
      default: 2,
      min: 0,                                // N lates allowed before penalty kicks in
    },

    escalationAfter: {
      type: Number,
      default: 3,
      min: 1,                                // escalate to HR / next level after N late marks
    },
  },
  { _id: false }
);

// ─── Sub-Schema: Sandwich Rule ────────────────────────────────────────────────
// Spec: enabled, includeHolidays, includeWeekends, consecutiveLeaveThreshold
const sandwichRuleSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },

    includeHolidays: {
      type: Boolean,
      default: true,                         // holidays between leave days counted as leave
    },

    includeWeekends: {
      type: Boolean,
      default: true,                         // weekends between leave days counted as leave
    },

    consecutiveLeaveThreshold: {
      type: Number,
      default: 2,
      min: 1,                                // trigger sandwich only if leave >= N consecutive days
    },
  },
  { _id: false }
);

// ─── Sub-Schema: Overtime ─────────────────────────────────────────────────────
// Spec: enabled, compensationType (comp_off|salary), minimumMinutes
const overtimeSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },

    compensationType: {
      type: String,
      enum: ["comp_off", "salary"],
      default: "comp_off",                   // comp_off = compensatory off day | salary = cash payout
    },

    minimumMinutes: {
      type: Number,
      default: 60,
      min: 1,                                // minimum OT minutes before it is counted
    },

    // Rate multiplier for OT cash payout (e.g. 1.5 = 1.5x hourly rate)
    // Only applicable when compensationType = "salary"
    rateMultiplier: {
      type: Number,
      default: 1.5,
      min: 1,
    },

    // Max OT hours allowed per day
    maxHoursPerDay: {
      type: Number,
      default: 4,
      min: 0,
    },
  },
  { _id: false }
);

// ─── Main AttendancePolicy Schema ─────────────────────────────────────────────
const attendancePolicySchema = new mongoose.Schema(
  {
    org_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    unit_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Unit",
      default: null,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },

    status: {
      type: String,
      enum: ["draft", "active", "inactive", "archived"],
      default: "draft",
      index: true,
    },

    version: {
      type: Number,
      default: 1,
      min: 1,                                // incremented on every PUT
    },

    // ── Shift ──────────────────────────────────────────────────────────────────
    // Spec: name, start (HH:MM), end (HH:MM), graceMinutes, minimumHours, halfDayMinHours
    shift: {
      type: shiftSchema,
      required: true,
    },

    // ── workWeek ───────────────────────────────────────────────────────────────
    // Spec: "reference CompanyConfig.workWeek — do not duplicate"
    // We store NO workWeek data here. At runtime the engine reads
    // CompanyConfig.workWeek for this tenant. No field defined — by design.

    // ── Late Mark ──────────────────────────────────────────────────────────────
    lateMark: {
      type: lateMarkSchema,
      default: () => ({}),
    },

    // ── Sandwich Rule ──────────────────────────────────────────────────────────
    sandwichRule: {
      type: sandwichRuleSchema,
      default: () => ({}),
    },

    // ── Overtime ───────────────────────────────────────────────────────────────
    overtime: {
      type: overtimeSchema,
      default: () => ({}),
    },

    // ── Shift Reference ─────────────────────────────────────────────────────
    // Optional: Reference to actual Shift model. If set, use shift timings.
    // Fallback: Use embedded shift schema timings.
    shift_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      default: null,
      index: true,
    },

    // ── Scope — same structure as LeavePolicy.applicableFor ───────────────────
    // Spec: "Same applicableFor scope as LeavePolicy"
    applicableFor: {
      departments: [{ type: mongoose.Schema.Types.ObjectId, ref: "Department" }],
      designations: [{ type: mongoose.Schema.Types.ObjectId, ref: "Designation" }],
      roles: [{ type: String }],             // e.g. ["hr_manager", "employee"]
      locations: [{ type: String, trim: true }],
      employmentTypes: {
        type: [String],
        enum: ["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"],
      },
    },

    // ── Shift Swap Approval Type ────────────────────────────────────────────────
    // Determines the approval flow for shift swap requests
    shiftSwapApprovalType: {
      type: String,
      enum: ["EMPLOYEE_THEN_MANAGER", "MANAGER_ONLY"],
      default: "EMPLOYEE_THEN_MANAGER"
        // EMPLOYEE_THEN_MANAGER: A requests → B accepts/declines → Manager approves/rejects
        // MANAGER_ONLY: A requests → Manager directly approves/rejects (skips B step)
    },

    // ── Audit ──────────────────────────────────────────────────────────────────
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

// ─── Indexes ──────────────────────────────────────────────────────────────────
attendancePolicySchema.index({ org_id: 1, company_id: 1, status: 1, isDeleted: 1 });
attendancePolicySchema.index({ org_id: 1, company_id: 1, "applicableFor.departments": 1 });
attendancePolicySchema.index({ org_id: 1, company_id: 1, "applicableFor.designations": 1 });
attendancePolicySchema.index({ org_id: 1, company_id: 1, "applicableFor.roles": 1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────
attendancePolicySchema.virtual("isActive").get(function () {
  return this.status === "active";
});

// ─── Pre-save Hook ────────────────────────────────────────────────────────────
// Mongoose 9 passes no `next` to pre hooks — throw to fail the save
attendancePolicySchema.pre("save", function () {
  // halfDayMinHours must be less than minimumHours
  if (
    this.shift &&
    this.shift.halfDayMinHours >= this.shift.minimumHours
  ) {
    throw new Error("shift.halfDayMinHours must be less than shift.minimumHours");
  }
  // next();
});

// ─── Query Middleware ─────────────────────────────────────────────────────────
attendancePolicySchema.pre(/^find/, function (next) {
  if (!this.getOptions().includeDeleted) {
    this.where({ isDeleted: false });
  }
//   next();
});

// ─── Static: get active policies for tenant ───────────────────────────────────
attendancePolicySchema.statics.getActivePolicies = function (company_id) {
  return this.find({ company_id, status: "active", isDeleted: false });
};

module.exports = mongoose.model("AttendancePolicy", attendancePolicySchema);