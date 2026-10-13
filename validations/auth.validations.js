const Joi = require("joi");

const superAdminLoginSchema = Joi.object({
  email: Joi.string()
    .email()
    .required()
    .messages({
      "string.empty": "Email is required",
      "string.email": "Email must be valid"
    }),

  password: Joi.string()
    .min(6)
    .required()
    .messages({
      "string.empty": "Password is required",
      "string.min": "Password must be at least 6 characters"
    })
});
const tenantLoginSchema = Joi.object({

  email: Joi.string()
    .trim()
    .email()
    .required(),

  password: Joi.string()
    .trim()
    .min(6)
    .required()

});
const createRoleSchema = Joi.object({

  name: Joi.string()
    .trim()
    .min(2)
    .max(50)
    .required()
    .messages({
      "string.empty": "Role name is required"
    }),

  slug: Joi.string()
    .trim()
    .lowercase()
    // Custom role slugs can include numeric suffixes.
    .pattern(/^[a-z0-9_]+$/)
    .required()
    .messages({
      "string.pattern.base": "Slug must contain only lowercase letters, numbers and underscores"
    }),

  description: Joi.string()
    .allow("")
    .optional(),
    level: Joi.string()
    .valid("org", "company", "unit")
    .required(),

  permissions: Joi.array()
    .items(
      Joi.string().hex().length(24)
    )
    .min(1)
    .required()
    .messages({
      "array.min": "At least one permission is required"
    })

});
// Update schema — all fields optional
const updateRoleSchema = Joi.object({
  name: Joi.string().trim().min(2).max(50).optional(),
  slug: Joi.string().trim().lowercase().pattern(/^[a-z0-9_]+$/).optional()
    .messages({ "string.pattern.base": "Slug must contain only lowercase letters, numbers and underscores" }),
  description: Joi.string().allow("").optional(),
  level: Joi.string().valid("org", "company", "unit").optional(),
  permissions: Joi.array().items(Joi.string().hex().length(24)).min(1).optional()
    .messages({ "array.min": "At least one permission is required" }),
  userClass: Joi.string().optional(),
  modules: Joi.array().items(Joi.string()).optional(),
});

const validateRoleUpdate = (req, res, next) => {
  const { error } = updateRoleSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ success: false, message: error.details[0].message });
  }
  next();
};

const validateRole = (req, res, next) => {

  const { error } = createRoleSchema.validate(req.body);

  if (error) {
    return res.status(400).json({
      success: false,
      message: error.details[0].message
    });
  }

  next();

};

const forgotPasswordSchema = Joi.object({
  email: Joi.string()
    .email()
    .required()
    .messages({
      "string.empty": "Email is required",
      "string.email": "Email must be valid"
    })
});

const resetPasswordSchema = Joi.object({
  token: Joi.string().required(),
  password: Joi.string()
    .min(6)
    .required()
    .messages({
      "string.empty": "Password is required",
      "string.min": "Password must be at least 6 characters"
    })
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string()
    .required()
    .messages({
      "string.empty": "Current password is required"
    }),
  newPassword: Joi.string()
    .min(8)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*(),.?":{}|<>])[A-Za-z\d!@#$%^&*(),.?":{}|<>]{8,}$/)
    .required()
    .messages({
      "string.empty": "New password is required",
      "string.min": "Password must be at least 8 characters",
      "string.pattern.base": "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character"
    })
});

module.exports = {
  superAdminLoginSchema,
  tenantLoginSchema,
  createRoleSchema,
  updateRoleSchema,
  validateRole,
  validateRoleUpdate,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema
};