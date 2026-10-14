const Joi = require("joi");
const { slugifyRoleName, SLUG_PATTERN, SLUG_MAX_LENGTH } = require("../utils/roleSlug");

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
    .email()
    .required(),

  password: Joi.string()
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

  // Optional — the form has no slug field. If sent, it is normalised in
  // validateRole; if missing, the service derives it from the name.
  slug: Joi.string()
    .trim()
    .max(SLUG_MAX_LENGTH)
    .pattern(SLUG_PATTERN)
    .optional()
    .messages({
      "string.pattern.base": "Slug must start with a letter and contain only lowercase letters, numbers and underscores"
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
  slug: Joi.string().trim().max(SLUG_MAX_LENGTH).pattern(SLUG_PATTERN).optional()
    .messages({ "string.pattern.base": "Slug must start with a letter and contain only lowercase letters, numbers and underscores" }),
  description: Joi.string().allow("").optional(),
  level: Joi.string().valid("org", "company", "unit").optional(),
  permissions: Joi.array().items(Joi.string().hex().length(24)).min(1).optional()
    .messages({ "array.min": "At least one permission is required" }),
  userClass: Joi.string().optional(),
  modules: Joi.array().items(Joi.string()).optional(),
});

// Normalise a client-sent slug ("Test Role R2" → "test_role_r2") so a slug
// auto-built by the frontend never fails on spaces, capitals or digits.
const normaliseRoleSlug = (body) => {
  if (body && typeof body.slug === "string") {
    const slug = slugifyRoleName(body.slug);
    if (slug) body.slug = slug;
    else delete body.slug;
  }
};

const validateRoleUpdate = (req, res, next) => {
  normaliseRoleSlug(req.body);
  const { error } = updateRoleSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ success: false, message: error.details[0].message });
  }
  next();
};

const validateRole = (req, res, next) => {

  normaliseRoleSlug(req.body);

  if (req.body && typeof req.body.name === "string" && !slugifyRoleName(req.body.name)) {
    return res.status(400).json({
      success: false,
      message: "Role name must contain at least one letter or number",
    });
  }

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