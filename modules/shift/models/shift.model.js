// modules/shift/models/shift.model.js
//
// Shift = ek kaam ka time block (Day Shift, Night Shift, General etc.)
//
// Hierarchy context:
//   Shift belongs to a Unit (unit_id required).
//   Company Admin / Unit Admin shifts create karte hain.
//   Employees rosters ke through shifts se linked hote hain.
//
// Key design decisions:
//   - isDefault: true = agar employee ka roster nahi mila toh yeh shift use hogi
//   - Sirf ek hi shift isDefault: true ho sakti hai per unit (service layer enforce karega)
//   - applicableDays: ["MON","TUE","WED","THU","FRI"] — which days this shift runs
//   - startTime / endTime: "HH:MM" 24-hour format string (e.g. "09:00", "21:00")
//     String rakha hai — timezone handling frontend pe, backend pure HH:MM compare karta hai
//   - gracePeriodMinutes: punch-in ko itne minute late tak LATE nahi maana jaayega
//   - halfDayThresholdMinutes: itne ghante kaam kiya toh HALF_DAY (default 240 = 4 hrs)

const mongoose = require("mongoose");
const { Schema } = mongoose;

const SHIFT_TYPE_VALUES = ["GENERAL", "MORNING", "EVENING", "NIGHT", "ROTATIONAL", "DAY"];

const shiftSchema = new Schema(
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

    // ─── Identity ────────────────────────────────────────────
    name: {
      type:     String,
      required: [true, "Shift name is required"],
      trim:     true,
      // e.g. "Morning Shift", "Night Shift", "General"
    },

    // ─── Timing ──────────────────────────────────────────────
    // "HH:MM" 24-hour format
    startTime: {
      type:     String,
      required: [true, "startTime is required"],
      match:    [/^\d{2}:\d{2}$/, "startTime must be HH:MM format"],
      // e.g. "09:00", "21:00"
    },

    endTime: {
      type:     String,
      required: [true, "endTime is required"],
      match:    [/^\d{2}:\d{2}$/, "endTime must be HH:MM format"],
      // Night shift: startTime "21:00", endTime "06:00" (next day)
      // isNextDay flag handles this
    },

    // true = endTime is on the next calendar day (Night shifts)
    // e.g. 21:00 → 06:00 next day
    isNextDay: {
      type:    Boolean,
      default: false,
    },

    // Minutes allowed after startTime before marking LATE
    // e.g. 15 = punch-in by 09:15 is still ON_TIME
    gracePeriodMinutes: {
      type:    Number,
      default: 15,
      min:     0,
      max:     120,
    },

    // Minimum minutes worked to count as HALF_DAY (not ABSENT)
    // Default 240 = 4 hours
    halfDayThresholdMinutes: {
      type:    Number,
      default: 240,
      min:     60,
    },

    // Total working minutes expected per day (excluding breaks)
    // Used for OT calculation: workedMinutes > workingMinutes = OT
    workingMinutes: {
      type:    Number,
      default: 480, // 8 hours
      min:     60,
    },

    // ─── Schedule ────────────────────────────────────────────
    // Which days of week this shift applies
    applicableDays: {
      type:    [String],
      enum:    ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
      default: ["MON", "TUE", "WED", "THU", "FRI"],
    },

    // ─── Type ────────────────────────────────────────────────
    shiftType: {
      type:    String,
      enum:    SHIFT_TYPE_VALUES,
      default: "GENERAL",
      set:     (value) => (value == null ? value : String(value).trim().toUpperCase()),
    },

    // ─── Default flag ────────────────────────────────────────
    // true = fallback shift when no roster assigned to employee
    // Only ONE shift per unit should have isDefault: true
    // Enforced in shift.service.js on create/update
    isDefault: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    // ─── Status ──────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
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
// name unique per unit
shiftSchema.index({ unit_id: 1, name: 1, is_deleted: 1 }, { unique: true });

// Fast lookup for default shift per unit
shiftSchema.index({ unit_id: 1, isDefault: 1, is_deleted: 1 });

// Status filter
shiftSchema.index({ unit_id: 1, status: 1, is_deleted: 1 });

module.exports = mongoose.model("Shift", shiftSchema);