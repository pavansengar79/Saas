// modules/attendance/attendance.validation.js

const Joi = require("joi");

// ─── Helper: MongoDB ObjectId pattern ────────────────────────
const objectId = Joi.string()
  .regex(/^[a-fA-F0-9]{24}$/)
  .messages({ "string.pattern.base": "Invalid ID format" });

// ─── GET /me/attendance?month=YYYY-MM ────────────────────────
// Employee apni attendance fetch karta hai
exports.getMyAttendance = Joi.object({
  month: Joi.string()
    .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
    .required()
    .messages({
      "any.required":         "month query param required hai (e.g. 2026-04)",
      "string.pattern.base":  "month format YYYY-MM hona chahiye (e.g. 2026-04)",
    }),
  orgId: objectId.optional(),
  companyId: objectId.optional(),
  unit_id: objectId.optional(),
});

// ─── POST /punch-in ───────────────────────────────────────────
// Employee punch-in karta hai
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
// Employee punch-out karta hai
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
      "string.pattern.base": "month format YYYY-MM hona chahiye",
    }),
  
  // Date range support (new)
  startDate: Joi.date()
    .iso()
    .optional()
    .messages({
      "date.format": "startDate ISO format mein hona chahiye (YYYY-MM-DD)",
    }),
  
  endDate: Joi.date()
    .iso()
    .min(Joi.ref("startDate"))
    .optional()
    .messages({
      "date.format": "endDate ISO format mein hona chahiye (YYYY-MM-DD)",
      "date.min": "endDate, startDate se pehle nahi ho sakti",
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
// HR manually kisi record ko fix karta hai
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
    .messages({ "any.required": "status required hai" }),

  checkIn: Joi.date()
    .iso()
    .optional()
    .allow(null),

  checkOut: Joi.date()
    .iso()
    .min(Joi.ref("checkIn"))
    .optional()
    .allow(null)
    .messages({
      "date.min": "checkOut, checkIn se pehle nahi ho sakta",
    }),

  remarks: Joi.string()
    .trim()
    .min(5)
    .max(500)
    .required()
    .messages({
      "any.required": "Regularization ke liye remarks required hain",
      "string.min":   "Remarks kam se kam 5 characters ke hone chahiye",
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
      "any.required":        "month required hai",
      "string.pattern.base": "month format YYYY-MM hona chahiye",
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