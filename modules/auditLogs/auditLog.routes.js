"use strict";
const express = require("express");
const router  = express.Router();
const ctrl    = require("./auditLog.controller");
const auditAnalyticsController = require("./auditAnalytics.controller");
const { authenticate }  = require("../../middlewares/auth.middleware");
const checkPermission   = require("../../middlewares/permission.middleware");

// ═══════════════════════════════════════════════════════════════
// AI-POWERED ANALYTICS ENDPOINTS (NEW)
// ═══════════════════════════════════════════════════════════════

// Natural language query execution
router.post(
  "/analytics/query",
  authenticate,
  checkPermission("auditLog.read"),
  auditAnalyticsController.executeQuery
);

// Get metadata for filters (modules, actions)
router.get(
  "/analytics/metadata",
  authenticate,
  checkPermission("auditLog.read"),
  auditAnalyticsController.getMetadata
);

// Dashboard stats
router.get(
  "/analytics/dashboard",
  authenticate,
  checkPermission("auditLog.read"),
  auditAnalyticsController.getDashboard
);

// ═══════════════════════════════════════════════════════════════
// STANDARD AUDIT LOG ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// ── STRICT ADMIN-ONLY ACCESS ─────────────────────────────────────────────


// Only ORG_ADMIN, COMPANY_ADMIN, UNIT_ADMIN can access audit logs



router.get("/", authenticate, ctrl.getLogs);

router.get("/export", authenticate, ctrl.exportLogs);

// HR-specific employee audit logs (filtered for HR operations)
router.get("/hr/employee-logs", authenticate, ctrl.getHREmployeeLogs);

// Employee timeline — by employeeId (also admin-only)
router.get("/employee/:employeeId", authenticate, ctrl.getEmployeeTimeline);

module.exports = router;