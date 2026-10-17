const Joi = require("joi");

const objectId = Joi.string().pattern(/^[a-fA-F0-9]{24}$/);

// --- credit sub-schema (spec: totalPerYear, frequency, perCycle, accrualType, accrualDay, roundingRule, probationApplicable)
const creditSchema = Joi.object({
  totalPerYear: Joi.number().min(0).required(),
  frequency: Joi.string().valid("NONE", "MONTHLY", "QUARTERLY", "YEARLY").default("YEARLY"),
  perCycle: Joi.number().min(0).default(0),
  accrualType: Joi.string().valid("NONE", "MONTHLY", "QUARTERLY", "YEARLY").default("YEARLY"),
  accrualDay: Joi.number().integer().min(1).max(31).default(1),
  roundingRule: Joi.string().valid("FLOOR", "CEIL", "ROUND").default("ROUND"),
  probationApplicable: Joi.boolean().default(false),
});

// --- balance sub-schema (spec: maxBalance, allowNegative, maxNegative, resetCycle)
const balanceSchema = Joi.object({
  maxBalance: Joi.number().min(0).allow(null).default(null),
  allowNegative: Joi.boolean().default(false),
  maxNegative: Joi.number().min(0).default(0),              // was maxNegativeDays
  resetCycle: Joi.string().valid("YEARLY", "FISCAL_YEAR", "NEVER").default("YEARLY"),
});

const leaveTypeSchema = Joi.object({
  leaveTypeId: objectId.optional().allow(null),

  // identity
  name: Joi.string().trim().max(100).optional(),
  code: Joi.string().trim().uppercase().max(10).optional(),
  description: Joi.string().trim().max(500).optional().allow(""),
  isPaid: Joi.boolean().default(true),
  isPublic: Joi.boolean().default(true),
  color: Joi.string().pattern(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/).default("#4F46E5"),

  // credit sub-object per spec
  credit: creditSchema.required(),

  // balance sub-object per spec
  balance: balanceSchema.optional(),

  // eligibility
  genderRestriction: Joi.string().valid("ALL", "MALE", "FEMALE", "OTHER").default("ALL"),
  minTenureMonths: Joi.number().min(0).default(0),
  applicableEmploymentTypes: Joi.array()
    .items(Joi.string().valid("FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"))
    .default(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"]),
  cooldownDays: Joi.number().min(0).default(0),

  sandwichRule: Joi.object({
    override: Joi.boolean().default(false),
    enabled: Joi.boolean().default(false),
    includeHolidays: Joi.boolean().default(true),
    includeWeekends: Joi.boolean().default(true),
  }).optional(),

  // carryForward — spec field: max  (was maxDays)
  carryForward: Joi.object({
    allowed: Joi.boolean().default(false),
    max: Joi.number().min(0).default(0),                    // spec: max
    expiryDays: Joi.number().min(0).default(90),
    expiryAction: Joi.string().valid("LAPSE", "ENCASH").default("LAPSE"),
    carryForwardOn: Joi.string().default("YEAR_END"),
  }).optional(),

  // encashment — spec fields: maxDays, minBalance  (were maxDaysPerYear, minBalanceRequired)
  encashment: Joi.object({
    allowed: Joi.boolean().default(false),
    maxDays: Joi.number().min(0).default(0),                // spec: maxDays
    minBalance: Joi.number().min(0).default(0),             // spec: minBalance
    applicableAt: Joi.array()
      .items(Joi.string().valid("YEAR_END", "RESIGNATION", "ANYTIME"))
      .default(["YEAR_END"]),
    taxable: Joi.boolean().default(true),
  }).optional(),

  // application — spec field name (was applicationRules); maxDays, maxPerMonth (were maxDaysPerRequest, maxDaysPerMonth)
  application: Joi.object({
    minDays: Joi.number().min(0.5).default(0.5),
    maxDays: Joi.number().min(0).allow(null).default(null),
    maxPerMonth: Joi.number().min(0).allow(null).default(null),
    advanceNoticeDays: Joi.number().min(0).default(0),
    allowBackdated: Joi.boolean().default(false),
    backdatedAllowedDays: Joi.number().min(0).default(0),
    allowHalfDay: Joi.boolean().default(true),
    allowContinuousWithHoliday: Joi.boolean().default(true),
    requireReasonMinLength: Joi.number().min(0).default(10),
    cooldownDays: Joi.number().min(0).default(0),
  }).optional(),

  // approvalFlow — spec field: levels[]  (was levelLabels)
  approvalFlow: Joi.object({
    type: Joi.string().valid("AUTO", "L1", "L1_L2").default("L1_L2"),
    levels: Joi.array().items(Joi.string()).default(["Reporting Manager", "HR Manager"]),
    autoApproveAfterHours: Joi.number().min(0).allow(null).default(null),
  }).optional(),

  // documentRule — spec field name singular (was documentRules)
  documentRule: Joi.object({
    required: Joi.boolean().default(false),
    afterDays: Joi.number().min(0).allow(null).default(null),
    allowedTypes: Joi.array().items(Joi.string()).default(["pdf", "jpg", "jpeg", "png"]),
  }).optional(),

  isActive: Joi.boolean().default(true),
  sortOrder: Joi.number().default(0),
});

const createPolicySchema = Joi.object({
  name: Joi.string().trim().max(150).required(),
  description: Joi.string().trim().max(1000).optional().allow(""),
  effectiveFrom: Joi.date().required(),
  effectiveTo: Joi.date().greater(Joi.ref("effectiveFrom")).allow(null).optional(),
  status: Joi.string().valid("draft", "active").default("draft"),
  applicableFor: Joi.object({
    departments: Joi.array().items(objectId).default([]),
    designations: Joi.array().items(objectId).default([]),
    roles: Joi.array().items(Joi.string()).default([]),
    locations: Joi.array().items(Joi.string()).default([]),
    employmentTypes: Joi.array()
      .items(Joi.string().valid("FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"))
      .default([]),
  }).optional(),
  sandwichRule: Joi.object({
    enabled: Joi.boolean().default(false),
    includeHolidays: Joi.boolean().default(true),
    includeWeekends: Joi.boolean().default(true),
    consecutiveLeaveThreshold: Joi.number().min(1).default(2),
  }).optional(),
  leaveTypes: Joi.array().items(leaveTypeSchema).default([]),
}).options({ stripUnknown: true });

const updatePolicySchema = createPolicySchema.fork(
  ["name", "effectiveFrom"],
  (schema) => schema.optional()
).keys({
  leaveTypes: Joi.array().items(leaveTypeSchema).optional(),
  changeNote: Joi.string().trim().max(500).optional().allow(null, ""),
});

const updateLeaveTypesSchema = Joi.object({
  leaveTypes: Joi.array().items(leaveTypeSchema).min(1).required(),
});

module.exports = { createPolicySchema, updatePolicySchema, updateLeaveTypesSchema };