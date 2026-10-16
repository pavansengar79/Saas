const Joi = require("joi");

// Leave Balance — Initialize
exports.initializeBalance = Joi.object({

  employeeId: Joi.string()
    .regex(/^[a-fA-F0-9]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid employee ID",
      "any.required": "Employee ID is required"
    }),

  leaveTypeId: Joi.string()
    .regex(/^[a-fA-F0-9]{24}$/)
    .required()
    .messages({
      "string.pattern.base": "Invalid leave type ID",
      "any.required": "Leave type ID is required"
    }),

  year: Joi.number()
    .integer()
    .min(2020)
    .max(2100)
    .default(new Date().getFullYear())
    .optional(),

  // HR can override the default
  // If null is sent, use LeaveType's defaultDaysPerYear
  totalAllocated: Joi.number()
    .min(0)
    .max(366)
    .optional()
    .allow(null),

});

exports.getLeaveBalances = Joi.object({
  year: Joi.number()
    .integer()
    .min(2020)
    .max(2100)
    .default(new Date().getFullYear())
    .optional(),
});

exports.adjustLeaveBalance = Joi.object({

  days: Joi.number()
    .required()
    .not(0)
    .messages({
      "any.required": "Days is required",
      "any.invalid":  "Days cannot be zero"
    }),

  reason: Joi.string()
    .trim()
    .min(5)
    .max(300)
    .required()
    .messages({
      "any.required": "Reason is required",
      "string.min":   "Reason must be at least 5 characters"
    }),

});