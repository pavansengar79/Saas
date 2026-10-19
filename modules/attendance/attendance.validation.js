// modules/attendance/attendance.validation.js

const Joi = require("joi");

// ─── Helper: MongoDB ObjectId pattern ────────────────────────
const objectId = Joi.string()
  .regex(/^[a-fA-F0-9]{24}$/)
  .messages({ "string.pattern.base": "Invalid ID format" });

// ─── GET /me/attendance?month=YYYY-MM ────────────────────────
// Employee fetches their attendance
exports.getMyAttendance = Joi.object({
  month: Joi.string()
    .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
    .required()
    .messages({
      "any.required":         "The month query parameter is required (e.g., 2026-04).",
      "string.pattern.base":  "Month must be in YYYY-MM format (e.g., 2026-04).",
    }),
  orgId: objectId.optional(),
  companyId: objectId.optional(),
  unit_id: objectId.optional(),
  // AT-06 / BR-21: My Attendance status filter (was rejected with "'status' is not allowed")
  status: Joi.string()
    .valid("PRESENT", "ABSENT", "HALF_DAY", "ON_LEAVE", "HOLIDAY", "WEEKEND", "LATE", "WFH", "ALL", "")
    .optional(),
});

// ─── POST /punch-in ───────────────────────────────────────────
// Employee punches in
exports.punchIn = Joi.object({
  isWFH: Joi.boolean().default(false),

  remarks: Joi.string()
    .trim()
    .max(500)
    .optional()
    .allow("", null),

  // Geolocation data (optional)
  geolocation: Joi.object({
    latitude: Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required(),
    accuracy: Joi.number().min(0).optional(), // GPS accuracy in meters
  }).optional(),
});

// ─── POST /punch-out ──────────────────────────────────────────
// Employee punches out
exports.punchOut = Joi.object({
  remarks: Joi.string()
    .trim()
    .max(500)
    .optional()
    .allow("", null),

  // Geolocation data (optional)
  geolocation: Joi.object({
    latitude: Joi.number().min(-90).max(90).required(),
    longitude: Joi.number().min(-180).max(180).required(),
    accuracy: Joi.number().min(0).optional(),
  }).optional(),
});

// ─── GET /attendance (HR — all employees) ────────────────────
exports.getAttendance = Joi.object({
  orgId: objectId.optional(),
  companyId: objectId.optional(),
  unit_id: objectId.optional(),

  month: Joi.string()
    .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional()
    .messages({
      "string.pattern.base": "Month must be in YYYY-MM format.",
    }),
  
  // Date range support (new)
  startDate: Joi.date()
    .iso()
    .optional()
    .messages({
      "date.format": "startDate must be in ISO format (YYYY-MM-DD).",
    }),
  
  endDate: Joi.date()
    .iso()
    .min(Joi.ref("startDate"))
    .optional()
    .messages({
      "date.format": "endDate must be in ISO format (YYYY-MM-DD).",
      "date.min": "endDate cannot be earlier than startDate.",
    }),

  employeeId: objectId.optional(),
  
  departmentId: objectId.optional()
    .messages({
      "string.pattern.base": "departmentId must be a valid ObjectId",
    }),

  status: Joi.string()
    .valid(
      "PRESENT", "ABSENT", "HALF_DAY",
      "ON_LEAVE", "HOLIDAY", "WEEKEND", "LATE", "WFH"
    )
    .optional(),

  page:  Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(31),
});

// ─── PATCH /attendance/:id/regularize (HR only) ───────────────
// HR manually corrects an attendance record
exports.regularize = Joi.object({
  regularizationType: Joi.string()
    .valid(
      "MISSED_PUNCH_IN", "MISSED_PUNCH_OUT", "BOTH_MISSED",
      "WRONG_TIME", "WFH_CORRECTION", "STATUS_CORRECTION"
    )
    .required(),

  status: Joi.string()
    .valid(
      "PRESENT", "ABSENT", "HALF_DAY",
      "ON_LEAVE", "HOLIDAY", "WEEKEND", "LATE", "WFH"
    )
    .required()
    .messages({ "any.required": "Status is required" }),

  checkIn: Joi.date()
    .iso()
    .optional()
    .allow(null),

  // AT-07: compare with check-in only when a check-in is sent. A "missed punch-out"
  // correction sends only checkOut, and Joi.ref("checkIn") then failed with
  // '"checkOut" date references "ref:checkIn" which must have a valid date format'.
  // The service still checks check-out against the saved check-in.
  checkOut: Joi.when("checkIn", {
    is: Joi.date().required(),
    then: Joi.date().iso().min(Joi.ref("checkIn")).allow(null),
    otherwise: Joi.date().iso().allow(null),
  })
    .optional()
    .messages({
      "date.min": "Check-out must be after check-in",
    }),

  remarks: Joi.string()
    .trim()
    .min(5)
    .max(500)
    .required()
    .messages({
      "any.required": "Remarks are required for regularization",
      "string.min":   "Remarks must be at least 5 characters long",
    }),

  attachments: Joi.array()
    .items(Joi.string().uri())
    .default([]),
});

// ─── GET /attendance/summary?month=YYYY-MM ────────────────────
// Summary: present, absent, late count etc.
exports.getSummary = Joi.object({
  month: Joi.string()
    .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
    .required()
    .messages({
      "any.required":        "Month is required.",
      "string.pattern.base": "Month must be in YYYY-MM format.",
    }),

  orgId: objectId.optional(),
  companyId: objectId.optional(),
  unit_id: objectId.optional(),
  employeeId: objectId.optional(),
});

// ─── POST /attendance/admin/punch-in (HR + Biometric Sync) ───────────────
exports.adminPunchIn = Joi.object({
  employeeId: objectId.required()
    .messages({ "any.required": "employeeId is required" }),
  
  punchTime: Joi.date()
    .iso()
    .optional()
    .messages({ "date.format": "punchTime must be ISO format" }),
  
  punchSource: Joi.string()
    .valid('BIOMETRIC_SYNC', 'MANUAL_SYNC', 'ADMIN_PUNCH')
    .optional()
    .default('BIOMETRIC_SYNC'),
  
  remarks: Joi.string()
    .trim()
    .max(500)
    .optional()
    .allow("", null),
});

// ─── POST /attendance/admin/punch-out (HR + Biometric Sync) ───────────────
exports.adminPunchOut = Joi.object({
  employeeId: objectId.required()
    .messages({ "any.required": "employeeId is required" }),
  
  punchTime: Joi.date()
    .iso()
    .optional()
    .messages({ "date.format": "punchTime must be ISO format" }),
  
  punchSource: Joi.string()
    .valid('BIOMETRIC_SYNC', 'MANUAL_SYNC', 'ADMIN_PUNCH')
    .optional()
    .default('BIOMETRIC_SYNC'),
  
  remarks: Joi.string()
    .trim()
    .max(500)
    .optional()
    .allow("", null),
});