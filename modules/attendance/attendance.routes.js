// modules/attendance/attendance.routes.js
//
// Route Rules:
//   Employee (self)  → punch-in, punch-out, own records
//   HR Manager+      → all employees' records, regularize
//
// ⚠️  /me/* routes MUST come before /:id routes — Express order matters

const express    = require("express");
const router     = express.Router();

const attendanceController             = require("./attendance.controller");
const attendanceValidation             = require("./attendance.validation");
const { authenticate }                 = require("../../middlewares/auth.middleware");
const { requireTenantUser }            = require("../../middlewares/checkRole.middleware");
const checkPermission                  = require("../../middlewares/permission.middleware");
const checkTrial                       = require("../../middlewares/checkTrial.middleware");
const validate                         = require("../../middlewares/validate.middleware");

// ── Global guards — on all routes ────────────────────────────
router.use(authenticate);
router.use(requireTenantUser);
router.use(checkTrial);

// ─────────────────────────────────────────────────────────────
// EMPLOYEE SELF-SERVICE routes  (/me/*)
// Must be declared BEFORE any /:id routes
// ─────────────────────────────────────────────────────────────

// ─── Attendance Policy (Company Config) ──────────────────────
const companyConfigController = require("../companyConfig/companyConfig.controller");
const { configSchema }        = require("../companyConfig/companyConfig.validation");

router.get(
  "/policy",
  checkPermission("attendance.read"),
  companyConfigController.getConfig
);

router.post(
  "/policy",
  checkPermission("attendance.create"),
  validate(configSchema),
  companyConfigController.createConfig
);

router.put(
  "/policy",
  checkPermission("attendance.update"),
  validate(configSchema),
  companyConfigController.updateConfig
);

// GET /hrms/me/attendance/today — today's punch status (attendance.read permission)
router.get(
  "/me/today",
  checkPermission("attendance.read"),
  attendanceController.getTodayStatus
);

// GET /hrms/me/attendance/summary?month=YYYY-MM — monthly summary (attendance.read permission)
router.get(
  "/me/summary",
  checkPermission("attendance.read"),
  validate(attendanceValidation.getSummary, "query"),
  attendanceController.getMySummary
);

// GET /hrms/me/attendance?month=YYYY-MM — full detail records (attendance.read permission)
router.get(
  "/me",
  checkPermission("attendance.read"),  
  validate(attendanceValidation.getMyAttendance, "query"),
  attendanceController.getMyAttendance
);

// POST /hrms/me/attendance/punch-in — punch in (attendance.create permission)
router.post(
  "/me/punch-in",
  checkPermission("attendance.create"),
  validate(attendanceValidation.punchIn),
  attendanceController.punchIn
);

// POST /hrms/me/attendance/punch-out — punch out (attendance.create permission - self-service)
// Enterprise HRMS: Punch-out is a self-service action like punch-in.
// Employees who can punch in should be able to punch out without additional permissions.
router.post(
  "/me/punch-out",
  checkPermission("attendance.create"),
  validate(attendanceValidation.punchOut),
  attendanceController.punchOut
);

// ─────────────────────────────────────────────────────────────
// ADMIN PUNCH-IN/OUT (HR + Biometric Sync)
// Requires attendance.update permission (HR/Unit Admin level)
// ─────────────────────────────────────────────────────────────

// POST /hrms/attendance/admin/punch-in — punch-in on behalf of employee
router.post(
  "/admin/punch-in",
  checkPermission("attendance.update"),
  validate(attendanceValidation.adminPunchIn),
  attendanceController.adminPunchIn
);

// POST /hrms/attendance/admin/punch-out — punch-out on behalf of employee
router.post(
  "/admin/punch-out",
  checkPermission("attendance.update"),
  validate(attendanceValidation.adminPunchOut),
  attendanceController.adminPunchOut
);

// ─────────────────────────────────────────────────────────────
// MANAGER routes (Team Attendance)
// ─────────────────────────────────────────────────────────────

// GET /hrms/attendance/clocked-in — Get all currently clocked-in employees
router.get(
  "/clocked-in",
  checkPermission("attendance.read"),
  attendanceController.getAllClockedIn
);

// GET /hrms/attendance/team — manager sees their team's attendance
router.get(
  "/team",
  checkPermission("attendance.read"),
  validate(attendanceValidation.getAttendance, "query"),
  attendanceController.getTeamAttendance
);

// ─────────────────────────────────────────────────────────────
// HR MANAGER + UNIT ADMIN routes (attendance.read permission)
// ─────────────────────────────────────────────────────────────

// GET /hrms/attendance?month=&employeeId=&status= — all employees (unit scoped)
router.get(
  "/",
  checkPermission("attendance.read"),
  validate(attendanceValidation.getAttendance, "query"),
  attendanceController.getAllAttendance
);

// PATCH /hrms/attendance/:id/regularize — HR manually fix kare
router.patch(
  "/:id/regularize",
  checkPermission("attendance.update"),
  validate(attendanceValidation.regularize),
  attendanceController.regularize
);

module.exports = router;