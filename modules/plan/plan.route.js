// modules/plan/plan.route.js

const express    = require("express");
const router     = express.Router();
const controller = require("./plan.controller");
const { authenticate }   = require("../../middlewares/auth.middleware");
const { authorizeRoles } = require("../../middlewares/role.middleware");

// ── Public routes — auth optional (for current plan info) ────────────────────
// Used on pricing page and during registration
// If authenticated, includes current subscription info
router.get("/public",     controller.getPublicPlans);
router.get("/:id/public", controller.getPlanById);

// ── Authenticated — current user's plan features ─────────────
// MUST be before /:id to avoid Express route conflict
// Call on frontend app load to cache feature gates
router.get("/my-features", authenticate, controller.getMyFeatures);

// ── Get current subscription plan details for org/company admins ─────
// Shows full plan info including modules and features
router.get("/my-plan", authenticate, controller.getMyPlan);

// ── Super Admin only ──────────────────────────────────────────
router.get(   "/",    authenticate, authorizeRoles("SUPER_ADMIN"), controller.getAllPlans);
router.post(  "/",    authenticate, authorizeRoles("SUPER_ADMIN"), controller.createPlan);
router.put(   "/:id", authenticate, authorizeRoles("SUPER_ADMIN"), controller.updatePlan);
router.delete("/:id", authenticate, authorizeRoles("SUPER_ADMIN"), controller.deletePlan);

module.exports = router;
