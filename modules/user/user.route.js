// modules/user/user.route.js
//
// UPDATED — Dynamic permission-based access control
// Permission slugs: employee.read, employee.create, employee.update, employee.delete

const express    = require("express");
const router     = express.Router();

const controller                       = require("./user.controller");
const { authenticate }                 = require("../../middlewares/auth.middleware");
const { requireTenantUser }            = require("../../middlewares/checkRole.middleware");
const checkPermission                  = require("../../middlewares/permission.middleware");
const validate                         = require("../../middlewares/validate.middleware");
const { inviteUserSchema, updateUserSchema } = require("./user.validation");
const { upload }                        = require("../../config/cloudinary");

// ── Global guards for all routes ─────────────────────────────
router.use(authenticate);
router.use(requireTenantUser);

// ── POST /users/invite ────────────────────────────────────────
// Requires: employee.create permission
router.post(
  "/invite",
  checkPermission("employee.create"),
  validate(inviteUserSchema),
  controller.inviteUser
);

// ── GET /users ────────────────────────────────────────────────
// Requires: user.read permission
// Filters: ?page=1&limit=10&search=&status=&roleId=&departmentId=
router.get(
  "/",
  checkPermission("user.read"),
  controller.getUsers
);

// ── POST /users/:id/photo (Upload Profile Photo) ────────────────
// Requires: employee.update permission
router.post(
  "/:id/photo",
  checkPermission("employee.update"),
  upload.single("profilePhoto"),
  controller.uploadProfilePhoto
);

// ── GET /users/:id/progression ────────────────────────────────
// Requires: employee.read permission
// IMPORTANT: Register /progression before /:id to avoid matching /:id
router.get(
  "/:id/progression",
  checkPermission("employee.read"),
  controller.getProgressionHistory
);

// ── PUT /users/:id ────────────────────────────────────────────
// Requires: employee.update permission
// Updatable: roleId, status, name, lastName, phone, departmentId, note
router.put(
  "/:id",
  checkPermission("employee.update"),
  validate(updateUserSchema),
  controller.updateUser
);

// ── DELETE /users/:id ─────────────────────────────────────────
// Requires: employee.delete permission
router.delete(
  "/:id",
  checkPermission("employee.delete"),
  controller.deleteUser
);

module.exports = router;