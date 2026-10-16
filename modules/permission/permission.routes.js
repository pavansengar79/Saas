const router     = require("express").Router();
const controller = require("./permission.controller");
const { authenticate }    = require("../../middlewares/auth.middleware");
const { requireSuperAdmin } = require("../../middlewares/checkRole.middleware");

// GET /api/v1/permissions — SUPER_ADMIN only
router.get("/", authenticate, requireSuperAdmin, controller.getPermissions);

module.exports = router;