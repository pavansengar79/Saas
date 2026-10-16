const express = require("express");
const router  = express.Router();

const leaveController = require("./leave.controller");
const leaveValidation = require("./leave.validation");

const { authenticate }  = require("../../middlewares/auth.middleware");
const checkPermission   = require("../../middlewares/permission.middleware");
const checkTrial        = require("../../middlewares/checkTrial.middleware");
const validate          = require("../../middlewares/validate.middleware");

// ── Global guards ─────────────────────────────────────────────────────────────
router.use(authenticate, checkTrial);

const requireUnitLevel = (req, res, next) => {
  if (req.user.level !== "unit") {
    return res.status(403).json({
      success: false,
      message: "Leave balance is available only to unit-level users",
    });
  }

  return next();
};

// ── SPECIFIC routes FIRST (must come before /:id) ────────────────────────────

// GET /leave/balances/my  ← must be above /:id
// Dynamic balance calculation from active policy
router.get(
  "/balances/my",
  checkPermission("leave.read"),
  requireUnitLevel,
  leaveController.getMyLeaveBalances
);

// GET /leave/balances/:employeeId
// Dynamic balance calculation from active policy
router.get(
  "/balances/:employeeId",
  checkPermission("leave.read"),
  validate(leaveValidation.getLeaveBalances, "query"),
  leaveController.getLeaveBalances
);

// ── LEAVE REQUESTS ────────────────────────────────────────────────────────────

// POST /leave  — apply leave
router.post(
  "/",
  checkPermission("leave.create"),
  leaveController.applyLeave
);

// GET /leave  — all leave requests (employee: their own, HR: their unit's)
router.get(
  "/",
  checkPermission("leave.read"),
  leaveController.getAllLeaveRequests
);

// GET /leave/calendar — team leave calendar (month-wise)
// MUST be before /:id
router.get(
  "/calendar",
  checkPermission("leave.read"),
  leaveController.getTeamCalendar
);

// GET /leave/reports/liability — leave liability report (finance/HR)
// MUST be before /:id
router.get(
  "/reports/liability",
  checkPermission("leave.read"),
  leaveController.getLeaveLiabilityReport
);
router.get(
  "/pending",
  // checkPermission("leave.approve"),
  leaveController.getPendingApprovals
);

// GET /leave/:id  — single leave request
router.get(
  "/:id",
  checkPermission("leave.read"),
  leaveController.getLeaveRequestById
);

// PATCH /leave/:id/toggle-status  ← before /:id
router.patch(
  "/:id/toggle-status",
  checkPermission("leave.update"),
  leaveController.toggleStatus
);

 // PATCH /leave/:id/edit — employee edits their own pending leave
 router.patch(
  "/:id/edit",
 checkPermission("leave.create"),
 leaveController.editLeaveRequest
);

// PATCH /leave/:id  — approve / reject
router.patch(
  "/:id",
  // checkPermission("leave.approve"),
  leaveController.updateLeaveStatus
);

// DELETE /leave/:id
router.delete(
  "/:id",
  checkPermission("leave.create"),
  leaveController.remove
);

module.exports = router;