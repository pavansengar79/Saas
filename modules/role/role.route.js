// modules/role/role.route.js
// Access Control routes - ADMIN ONLY (org_admin, company_admin, unit_admin)

const express        = require("express");
const router         = express.Router();
const roleController = require("./role.controller");
const { authenticate }  = require("../../middlewares/auth.middleware");
const checkPermission   = require("../../middlewares/permission.middleware");
const { validateRole, validateRoleUpdate }  = require("../../validations/auth.validations");

// ── Admin check middleware ─────────────────────────────────────
// Only admins (org_admin, company_admin, unit_admin) can access role management
const requireAdmin = (req, res, next) => {
  const adminRoles = ['org_admin', 'company_admin', 'unit_admin', 'SUPER_ADMIN', 'product_admin'];
  const userRole = req.user?.role || req.user?.roleSlug;
  
  if (!adminRoles.includes(userRole)) {
    return res.status(403).json({
      success: false,
      code: "ADMIN_ONLY",
      message: "Access Control is only available for administrators",
    });
  }
  next();
};

// ── All role routes require authentication + admin check ────────
router.use(authenticate, requireAdmin);

// ── Register specific routes before /:id ────────────────────
router.get(
  "/assignable-permissions",
  checkPermission("role.read"),
  roleController.getAssignablePermissions
);

// ── CRUD ─────────────────────────────────────────────────────
router.post(
  "/",
  checkPermission("role.create"),
  validateRole,
  roleController.createRole
);

router.get(
  "/",
  checkPermission("role.read"),
  roleController.getRoles
);

router.get(
  "/:id",
  checkPermission("role.read"),
  roleController.getRoleById
);

router.put(
  "/:id",
  checkPermission("role.update"),
  validateRoleUpdate,
  roleController.updateRole
);

router.delete(
  "/:id",
  checkPermission("role.delete"),
  roleController.deleteRole
);

// T-03 — Role Module Matrix
// PUT /roles/:id/modules → update which modules role can access
router.put(
  "/:id/modules",
  checkPermission("role.update"),
  roleController.updateRoleModules
);

module.exports = router;