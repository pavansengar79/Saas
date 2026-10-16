const express = require("express");
const router  = express.Router();

const { authenticate }    = require("../../middlewares/auth.middleware");
const { superAdminGuard } = require("../../middlewares/superAdminGuard.middleware");
const validate            = require("../../middlewares/validate.middleware");
const ctrl                = require("./superAdmin.controller");
const customerAuthenticate = require("../../middlewares/customerAuthenticate.middleware"); // ← no destructuring
const { tenantListSchema, planOverrideSchema, auditLogQuerySchema, createCustomerSchema, createOrgSchema, publicRegisterSchema } = require("./superAdmin.validation");

// ── PUBLIC ENDPOINTS (no auth required) ──────────────────────────────────
// Public registration
router.post(
  "/register",
  validate(publicRegisterSchema),
  ctrl.publicRegister
);

// ── Customer org creation — outside superAdminGuard ───────────
// This route is accessed with a customer token
router.post(
  "/customers/create-org",
  customerAuthenticate,
  ctrl.createOrgForCustomer
);

// ── All remaining routes are super admin only ─────────────────
router.use(authenticate);
router.use(superAdminGuard);

router.get("/hierarchy", ctrl.getCustomerHierarchy);

router.get(
  "/tenants",
  validate(tenantListSchema, "query"),
  ctrl.getAllTenants
);

router.get("/tenants/:id", ctrl.getTenantById);

router.post(
  "/tenants/:id/plan",
  validate(planOverrideSchema),
  ctrl.overridePlan
);

router.patch("/tenants/:id/status", ctrl.updateStatus);

router.post(
  "/customers",
  validate(createCustomerSchema),
  ctrl.createCustomer
);

// Super Admin approves pending customer
router.post("/customers/:id/approve", ctrl.approveCustomer);

router.get(
  "/audit-log",
  validate(auditLogQuerySchema, "query"),
  ctrl.getAuditLog
);

module.exports = router;