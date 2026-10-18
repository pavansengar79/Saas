// ─── Create Employee ──────────────────────────────
// employee.validation.js
const Joi = require("joi");

exports.createEmployeeSchema = Joi.object({

  // ─── Personal Info ────────────────────────────
  name: Joi.string()
    .min(2)
    .max(50)
    .required()
    .messages({
      "string.empty": "Name is required",
      "string.min":   "Name must be at least 2 characters",
      "string.max":   "Name must not exceed 50 characters"
    }),

  email: Joi.string()
    .email()
    .lowercase()
    .required()
    .messages({
      "string.empty": "Email is required",
      "string.email": "Please provide a valid email"
    }),

  phone: Joi.string()
    .pattern(/^(\+91[\s]?|[0])?[6-9]\d{9}$/)
    .required()
    .messages({
      "any.required": "Phone is required",
      "string.empty": "Phone is required",
      "string.pattern.base": "Please provide a valid 10 digit phone number"
    }),

  alternatePhone: Joi.string()
    .pattern(/^[6-9]\d{9}$/)
    .optional()
    .messages({
      "string.pattern.base": "Please provide a valid 10 digit phone number"
    }),

  epsEligible: Joi.boolean().optional(),

  dateOfBirth: Joi.date()
    .max("now")
    .optional()
    .messages({
      "date.max": "Date of birth cannot be in the future"
    }),

  gender: Joi.string()
    .valid("MALE", "FEMALE", "OTHER")
    .optional(),

  bloodGroup: Joi.string()
    .valid("A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-")
    .optional(),

  maritalStatus: Joi.string()
    .valid("SINGLE", "MARRIED", "DIVORCED", "WIDOWED")
    .optional(),

  profilePhoto: Joi.string()
    .uri()
    .optional(),
    about: Joi.string().max(500).optional().allow(null, ""),


  // ─── Address ──────────────────────────────────
  currentAddress: Joi.object({
    street:  Joi.string().optional(),
    city:    Joi.string().optional(),
    state:   Joi.string().optional(),
    country: Joi.string().optional(),
    pincode: Joi.string().pattern(/^\d{6}$/).optional().messages({
      "string.pattern.base": "Pincode must be 6 digits"
    })
  }).optional(),

  permanentAddress: Joi.object({
    street:  Joi.string().optional(),
    city:    Joi.string().optional(),
    state:   Joi.string().optional(),
    country: Joi.string().optional(),
    pincode: Joi.string().pattern(/^\d{6}$/).optional().messages({
      "string.pattern.base": "Pincode must be 6 digits"
    })
  }).optional(),

  // ─── Job Info ─────────────────────────────────
  departmentId: Joi.string()
    .hex()
    .length(24)
    .required()
    .messages({
      "string.empty":  "Department is required",
      "string.length": "Invalid department ID"
    }),

  designationId: Joi.string()
    .hex()
    .length(24)
    .required()
    .messages({
      "any.required": "Designation is required",
      "string.empty":  "Designation is required",
      "string.length": "Invalid designation ID"
    }),

  joiningDate: Joi.date()
    .required()
    .messages({
      "date.base":  "Invalid joining date",
      "any.required": "Joining date is required"
    }),

  employmentType: Joi.string()
    .valid("FULL_TIME", "PART_TIME", "CONTRACT", "INTERN")
    .default("FULL_TIME")
    .optional(),

  reportingManagerId: Joi.string()
    .hex()
    .length(24)
    .optional()
    .messages({
      "string.length": "Invalid manager ID"
    }),

  confirmationDate: Joi.date()
    .min(Joi.ref("joiningDate"))
    .optional()
    .messages({
      "date.min": "Confirmation date cannot be before joining date"
    }),

  // ─── Salary ───────────────────────────────────
  salary: Joi.object({

    basic: Joi.number()
      .min(0)
      .optional()
      .messages({
        "number.base": "Basic salary must be a number",
        "number.min":  "Basic salary cannot be negative"
      }),

    hra:              Joi.number().min(0).default(0).optional(),
    travelAllowance:  Joi.number().min(0).default(0).optional(),
    medicalAllowance: Joi.number().min(0).default(0).optional(),
    specialAllowance: Joi.number().min(0).default(0).optional(),
    customComponents: Joi.array().items(Joi.object({
      code:          Joi.string().uppercase().trim().required()
                     .messages({ "any.required": "Component code is required" }),
      name:          Joi.string().trim().required()
                     .messages({ "any.required": "Component name is required" }),
      amount:        Joi.number().min(0).default(0),
      taxable:       Joi.boolean().default(true),
      pfApplicable:  Joi.boolean().default(false),
      esiApplicable: Joi.boolean().default(false),
    })).default([]).optional(),
    pf:               Joi.number().min(0).default(0).optional(),
    esi:              Joi.number().min(0).default(0).optional(),
    tds:              Joi.number().min(0).default(0).optional(),
    currency:         Joi.string().default("INR").optional(),
    effectiveFrom:    Joi.date().optional()

  }).optional().messages({
    "any.required": "Salary details are required"
  }),

  // ─── Bank Details ─────────────────────────────
  bankDetails: Joi.object({
    accountNumber: Joi.string().optional(),
    ifscCode: Joi.string()
      .pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/)
      .optional()
      .messages({
        "string.pattern.base": "Invalid IFSC code format"
      }),
    bankName:    Joi.string().optional(),
    branchName:  Joi.string().optional(),
    accountType: Joi.string().valid("SAVINGS", "CURRENT").optional()
  }).optional(),

  // ─── Emergency Contact ────────────────────────
  emergencyContact: Joi.object({
    name:     Joi.string().optional(),
    phone:    Joi.string().pattern(/^[6-9]\d{9}$/).optional(),
    relation: Joi.string().optional()
  }).optional()

});

// ─── Update Employee ──────────────────────────────
exports.updateEmployeeSchema = Joi.object({

  name:           Joi.string().optional(),
  phone:          Joi.string().optional(),
  alternatePhone: Joi.string().optional(),
  dateOfBirth:    Joi.date().optional(),
  epsEligible:    Joi.boolean().optional(),
  gender:         Joi.string().valid("MALE", "FEMALE", "OTHER").optional(),
  bloodGroup:     Joi.string().valid("A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-").optional(),
  maritalStatus:  Joi.string().valid("SINGLE", "MARRIED", "DIVORCED", "WIDOWED").optional(),
  profilePhoto:   Joi.string().uri().optional(),

  currentAddress: Joi.object({
    street:  Joi.string().optional(),
    city:    Joi.string().optional(),
    state:   Joi.string().optional(),
    country: Joi.string().optional(),
    pincode: Joi.string().optional()
  }).optional(),

  permanentAddress: Joi.object({
    street:  Joi.string().optional(),
    city:    Joi.string().optional(),
    state:   Joi.string().optional(),
    country: Joi.string().optional(),
    pincode: Joi.string().optional()
  }).optional(),

  departmentId:       Joi.string().optional(),
  designationId:      Joi.string().optional(),
  reportingManagerId: Joi.string().optional(),
  employmentType:     Joi.string().valid("FULL_TIME", "PART_TIME", "CONTRACT", "INTERN").optional(),
  joiningDate:        Joi.date().optional(),
  confirmationDate:   Joi.date().optional(),
  status:             Joi.string().valid("ACTIVE", "INACTIVE", "ON_NOTICE", "TERMINATED", "ON_LEAVE").optional(),
  confirmCompanyAdminDeactivation: Joi.boolean().strict(),
  exitDate:           Joi.date().optional(),
  exitReason:         Joi.string().optional(),

  salary: Joi.object({
    basic:            Joi.number().optional(),
    hra:              Joi.number().optional(),
    travelAllowance:  Joi.number().optional(),
    medicalAllowance: Joi.number().optional(),
    specialAllowance: Joi.number().optional(),
    customComponents: Joi.array().items(Joi.object({
      code:          Joi.string().uppercase().trim().required()
                     .messages({ "any.required": "Component code is required" }),
      name:          Joi.string().trim().required()
                     .messages({ "any.required": "Component name is required" }),
      amount:        Joi.number().min(0).default(0),
      taxable:       Joi.boolean().default(true),
      pfApplicable:  Joi.boolean().default(false),
      esiApplicable: Joi.boolean().default(false),
    })).default([]).optional(),
    pf:               Joi.number().optional(),
    esi:              Joi.number().optional(),
    tds:              Joi.number().optional(),
    currency:         Joi.string().optional(),
    effectiveFrom:    Joi.date().optional()
  }).optional(),
  about: Joi.string().max(500).optional().allow(null, ""),


  bankDetails: Joi.object({
    accountNumber: Joi.string().optional(),
    ifscCode:      Joi.string().optional(),
    bankName:      Joi.string().optional(),
    branchName:    Joi.string().optional(),
    accountType:   Joi.string().valid("SAVINGS", "CURRENT").optional()
  }).optional(),

  emergencyContact: Joi.object({
    name:     Joi.string().optional(),
    phone:    Joi.string().optional(),
    relation: Joi.string().optional()
  }).optional(),

  // ─── Education ─────────────────────────────────────────────────────────────
  education: Joi.array().items(Joi.object({
    institution: Joi.string().trim().optional(),
    degree:      Joi.string().trim().optional(),
    from:        Joi.date().optional(),
    to:          Joi.date().optional()
  })).optional(),

  // ─── Work Experience ───────────────────────────────────────────────────────
  experience: Joi.array().items(Joi.object({
    company: Joi.string().trim().optional(),
    role:    Joi.string().trim().optional(),
    from:    Joi.date().optional(),
    to:      Joi.date().optional(),
    current: Joi.boolean().optional()
  })).optional(),

  // ─── Family Details ───────────────────────────────────────────────────────
  familyDetails: Joi.array().items(Joi.object({
    name:        Joi.string().trim().optional(),
    relation:    Joi.string().trim().optional(),
    dateOfBirth: Joi.date().optional(),
    phone:       Joi.string().optional()
  })).optional()

});

// ─── Upload Document ──────────────────────────────
exports.uploadDocumentSchema = Joi.object({
  documentType: Joi.string().valid(
    "AADHAR", "PAN", "PASSPORT", "DRIVING_LICENSE",
    "EXPERIENCE_LETTER", "RELIEVING_LETTER", "SALARY_SLIP", "PREVIOUS_APPOINTMENT_LETTER",
    "OFFER_LETTER", "APPOINTMENT_LETTER", "INCREMENT_LETTER", "PROMOTION_LETTER",
    "EDUCATION_CERTIFICATE", "MARKSHEET", "DEGREE_CERTIFICATE",
    "OTHER"
  ).required(),

  category: Joi.string().valid(
    "IDENTITY", "PREVIOUS_EMPLOYMENT", "CURRENT_EMPLOYMENT", "EDUCATION", "OTHER"
  ).required(),

  name:     Joi.string().required(),
  url:      Joi.string().uri().required(),
  fileSize: Joi.number().optional(),
  fileType: Joi.string().optional()
});

// ─── Activate Login ───────────────────────────────
exports.activateLoginSchema = Joi.object({
  roleId: Joi.string().required()
});