// modules/holiday/holiday.route.js

const express    = require("express");
const router     = express.Router();
const controller = require("./holiday.controller");
const { authenticate } = require("../../middlewares/auth.middleware");
const checkPermission  = require("../../middlewares/permission.middleware");

// ── Company Holiday CRUD ──────────────────────────────────
// ── Master List + Import — place first ──────────────────
router.get(  "/master",                     authenticate, checkPermission("holiday.read"),    controller.getMasterHolidays);
router.post( "/master",                     authenticate, checkPermission("holiday.create"), controller.createMasterHoliday);
router.patch( "/master/:id",                 authenticate, checkPermission("holiday.update"), controller.updateMasterHoliday);
router.patch( "/master/:id/toggle",          authenticate, checkPermission("holiday.update"), controller.toggleMasterHoliday);
router.delete("/master/:id",                 authenticate, checkPermission("holiday.delete"), controller.deleteMasterHoliday);
router.post( "/import",                     authenticate, checkPermission("holiday.create"), controller.importHolidays);

// ── Company Holiday CRUD — place afterward ───────────────
router.post(  "/",    authenticate, checkPermission("holiday.create"), controller.createHoliday);
router.get(   "/",    authenticate, checkPermission("holiday.read"),   controller.listHolidays);
router.get(   "/:id", authenticate, checkPermission("holiday.read"),   controller.getHoliday);
router.patch( "/:id", authenticate, checkPermission("holiday.update"), controller.updateHoliday);
router.delete("/:id", authenticate, checkPermission("holiday.delete"), controller.deleteHoliday);
router.patch( "/:id/toggle", authenticate, checkPermission("holiday.update"), controller.toggleHoliday);

module.exports = router;