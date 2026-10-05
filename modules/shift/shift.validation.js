// modules/shift/shift.validation.js
//
// Joi validation for Shift CRUD operations

const Joi = require("joi");

// ─── Helper: MongoDB ObjectId pattern ────────────────────────
const objectId = Joi.string()
  .regex(/^[a-fA-F0-9]{24}$/)
  .messages({ "string.pattern.base": "Invalid ID format" });

// ─── Helper: HH:MM time format ───────────────────────────────
const timeFormat = Joi.string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/)
  .messages({ "string.pattern.base": "Time must be in HH:MM format (e.g., 09:00)" });

const SHIFT_TYPE_VALUES = ["GENERAL", "MORNING", "EVENING", "NIGHT", "ROTATIONAL", "DAY"];

// ─── CREATE SHIFT ─────────────────────────────────────────────
// POST /shifts
exports.createShift = Joi.object({
  name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .required()
    .messages({
      "any.required": "Shift name is required",
      "string.min": "Shift name must be at least 2 characters",
      "string.max": "Shift name cannot exceed 100 characters",
    }),

  startTime: timeFormat.required()
    .messages({ "any.required": "startTime is required" }),

  endTime: timeFormat.required()
    .messages({ "any.required": "endTime is required" }),

  isNextDay: Joi.boolean()
    .default(false)
    .description("Set to true if shift ends on the next calendar day"),

  gracePeriodMinutes: Joi.number()
    .integer()
    .min(0)
    .max(60)
    .default(15)
    .description("Grace period in minutes after shift start"),

  halfDayThresholdMinutes: Joi.number()
    .integer()
    .min(60)
    .max(480)
    .default(240)
    .description("Minimum minutes to qualify as half day"),

  workingMinutes: Joi.number()
    .integer()
    .min(60)
    .max(1440)
    .default(480)
    .description("Total working minutes in the shift"),

  applicableDays: Joi.array()
    .items(Joi.string().valid("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"))
    .min(1)
    .default(["MON", "TUE", "WED", "THU", "FRI"])
    .description("Days of week this shift is applicable"),

  shiftType: Joi.string()
    .trim()
    .uppercase()
    .valid(...SHIFT_TYPE_VALUES)
    .default("GENERAL"),

  isDefault: Joi.boolean()
    .default(false)
    .description("Only one default shift allowed per unit"),

  unit_id: objectId
    .optional()
    .description("Target unit — defaults to user's unit if not provided"),

  status: Joi.string()
    .valid("ACTIVE", "INACTIVE")
    .default("ACTIVE"),
});

// ─── UPDATE SHIFT ─────────────────────────────────────────────
// PUT /shifts/:id
exports.updateShift = Joi.object({
  name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .optional(),

  startTime: timeFormat.optional(),

  endTime: timeFormat.optional(),

  isNextDay: Joi.boolean()
    .optional(),

  gracePeriodMinutes: Joi.number()
    .integer()
    .min(0)
    .max(60)
    .optional(),

  halfDayThresholdMinutes: Joi.number()
    .integer()
    .min(60)
    .max(480)
    .optional(),

  workingMinutes: Joi.number()
    .integer()
    .min(60)
    .max(1440)
    .optional(),

  applicableDays: Joi.array()
    .items(Joi.string().valid("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"))
    .min(1)
    .optional(),

  shiftType: Joi.string()
    .trim()
    .uppercase()
    .valid(...SHIFT_TYPE_VALUES)
    .optional(),

  isDefault: Joi.boolean()
    .optional()
    .description("Only one default shift allowed per unit"),

  unit_id: objectId.optional(),

  status: Joi.string()
    .valid("ACTIVE", "INACTIVE")
    .optional(),
});

// ─── GET SHIFTS (query params) ───────────────────────────────
// GET /shifts?status=&shiftType=&unit_id=
exports.getShifts = Joi.object({
  orgId: objectId.optional(),

  companyId: objectId.optional(),

  status: Joi.string()
    .valid("ACTIVE", "INACTIVE")
    .optional(),

  shiftType: Joi.string()
    .trim()
    .uppercase()
    .valid(...SHIFT_TYPE_VALUES)
    .optional(),

  unit_id: objectId.optional(),

  isDefault: Joi.boolean()
    .optional(),

  page: Joi.number()
    .integer()
    .min(1)
    .default(1),

  limit: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(20),
});
