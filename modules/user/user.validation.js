// modules/user/user.validation.js

const Joi = require("joi");

const objectId = Joi.string().hex().length(24);

// ── Invite User ───────────────────────────────────────────────
exports.inviteUserSchema = Joi.object({
  email: Joi.string()
    .email()
    .lowercase()
    .trim()
    .required()
    .messages({
      "any.required": "Email is required",
    }),
    name: Joi.string().trim().min(2).max(100).optional(),

  roleId: objectId.required().messages({
    "any.required": "Role is required",
  }),

  // Unit level role ke liye service layer me validate hoga
  departmentId: objectId.optional().allow(null),
    // Org Admin company assign kar sake
  company_id: objectId.optional().allow(null),

  // Company Admin unit assign kar sake
  unit_id: objectId.optional().allow(null),
});

// ── Update User ───────────────────────────────────────────────
exports.updateUserSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100),

  lastName: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .allow("", null),

  phone: Joi.string()
    .trim()
    .pattern(/^[0-9]{7,13}$/)
    .allow("", null),

  roleId: objectId,

  departmentId: objectId.allow(null),

  status: Joi.string()
    .valid("ACTIVE", "INACTIVE", "BLOCKED"),

  note: Joi.string()
    .trim()
    .max(500)
    .allow("", null),

}).min(1).messages({
  "object.min": "Provide at least one field to update",
});