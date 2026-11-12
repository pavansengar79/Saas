// route.js

const crypto  = require("crypto");
const express = require("express");
const router  = express.Router();

const authRoutes        = require("./modules/auth/auth.routes");
const tenantRoutes      = require("./modules/tenant/tenant.route");
const roleRoutes        = require("./modules/role/role.route");
const departmentRoutes  = require("./modules/department/department.route");
const designationRoutes = require("./modules/designation/designation.route");
const permissionRoutes  = require("./modules/permission/permission.routes");
const employeeRoutes    = require("./modules/employee/employee.routes");
const mfaRoutes         = require("./modules/auth/MFA/auth.mfa.routes");
const ssoRoutes         = require("./modules/auth/SSO/auth.sso.routes");
const leaveRoutes       = require("./modules/leave/leave.route");
const planRoutes        = require("./modules/plan/plan.route");
const companyRoutes     = require("./modules/company/company.route");
const organizationRoutes = require("./modules/organisation/organization.route");
const lobRoutes         = require("./modules/lob/lob.route");
const unitRoutes        = require("./modules/unit/unit.route");
const holidayRoutes     = require("./modules/holiday/holiday.route");
// Add these routes in route.js:
const attendanceRoutes       = require("./modules/attendance/attendance.routes");
const regularizationRoutes   = require("./modules/attendance/attendanceregularization.routes");
const auditLogRoutes         = require("./modules/auditLogs/auditLog.routes");
const payrollLockRoutes      = require("./modules/payrollPolicy/payrolllock.routes");
const notificationRoutes     = require("./modules/notification/notification.routes");

// ─── Admin Job Trigger (for manual testing) ──────────────────
const { runAutoAbsentMarker } = require("./jobs/autoAbsentMarker.job");
const { runShiftFinalization } = require("./jobs/shiftFinalization.job");
const { expireOldDelegations } = require("./modules/delegation/delegation.service");
const { runShiftSwapExpiry } = require("./jobs/shiftSwapExpiry.job");
const attendancePolicyRoutes = require("./modules/attendancePolicy/attendancePolicy.routes");
const payrollPolicyRoutes    = require("./modules/payrollPolicy/payrollPolicy.routes");
const leavePolicyRoutes      = require("./modules/leavePolicy/leavePolicy.routes");
const userRoutes             = require("./modules/user/user.route");
const superAdminRoutes       = require("./modules/superAdmin/superAdmin.routes");
const dashboardRoutes        = require("./modules/dashboard/dashboard.routes");
const companyConfigRoutes    = require("./modules/companyConfig/companyConfig.route");
const leaveTypeRoutes        = require("./modules/leave/leave.type.route");
const payslipRoutes               = require("./modules/payrollPolicy/payslip/payslip.routes");
const investmentDeclarationRoutes  = require("./modules/payrollPolicy/investmentDeclaration.routes");
const moduleRoutes           = require("./modules/module/module.routes");

// ── New modules (Prompt 11-15) ─────────────────────────────────────────────
const shiftRoutes      = require("./modules/shift/shift.routes");
const rosterRoutes     = require("./modules/shift/roster.routes");
const shiftSwapRoutes  = require("./modules/shift/shiftSwap.routes");
const delegationRoutes = require("./modules/delegation/delegation.routes");
const regularisationPolicyRoutes = require("./modules/attendance/regularisationPolicy.routes");
const policyVersionRoutes       = require("./modules/policyVersion/policyVersion.routes");
const biometricRoutes           = require("./modules/biometric/biometric.routes");
const subscriptionRouter        = require("./modules/subscription/subscription.route");

router.use("/auth",         authRoutes);
router.use("/auth/mfa",     mfaRoutes);
router.use("/auth/sso",     ssoRoutes);
router.use("/tenant",       tenantRoutes);
router.use("/roles",        roleRoutes);
router.use("/permissions",  permissionRoutes);
router.use("/plans",        planRoutes);
router.use("/companies",    companyRoutes);
router.use("/organization", organizationRoutes);
router.use("/lobs",         lobRoutes);
router.use("/units",        unitRoutes);
router.use("/departments",  departmentRoutes);
router.use("/designations", designationRoutes);
router.use("/employees",    employeeRoutes);
router.use("/leave/types",         leaveTypeRoutes);  // BEFORE /leave to avoid conflict
router.use("/leave",               leaveRoutes);
router.use("/holidays",            holidayRoutes);
router.use("/attendance",          attendanceRoutes);
router.use("/attendance/regularize", regularizationRoutes);
router.use("/audit-logs",          auditLogRoutes);
router.use("/payroll-lock",         payrollLockRoutes);
router.use("/notifications",        notificationRoutes);

// ─── Scheduled job triggers ───────────────────────────────────
// Called by GitHub Actions (.github/workflows/scheduled-jobs.yml).
// Auth: header "x-cron-secret" must equal process.env.CRON_SECRET.
// A Super Admin token is NOT accepted here.
const requireCronSecret = (req, res, next) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return res.status(503).json({ success: false, message: "CRON_SECRET is not configured on the server" });
  }
  const given = req.get("x-cron-secret") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: "Invalid cron secret" });
  }
  next();
};

const runAdminJob = (path, job) => {
  router.post(path, requireCronSecret, async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const result = await job();
      res.json({ success: true, job: path, durationMs: Date.now() - startedAt, data: result });
    } catch (err) { next(err); }
  });
};
runAdminJob("/admin/jobs/auto-absent",        runAutoAbsentMarker);
runAdminJob("/admin/jobs/shift-finalization", () => runShiftFinalization(120));
runAdminJob("/admin/jobs/shift-swap-expiry",  runShiftSwapExpiry);
runAdminJob("/admin/jobs/delegation-expiry",  expireOldDelegations);
router.use("/attendance-policies", attendancePolicyRoutes);
router.use("/payroll-policies",    payrollPolicyRoutes);
router.use("/leave-policies",      leavePolicyRoutes);
router.use("/users",               userRoutes);
router.use("/super-admin",         superAdminRoutes);
router.use("/dashboard",           dashboardRoutes);
router.use("/company-config",      companyConfigRoutes);
router.use("/payslips",            payslipRoutes);
router.use("/investment-declarations", investmentDeclarationRoutes);
router.use("/modules",          moduleRoutes);

// ── New routes ─────────────────────────────────────────────────────────────
router.use("/shifts",       shiftRoutes);
router.use("/rosters",      rosterRoutes);
router.use("/shift-swaps",  shiftSwapRoutes);
router.use("/subscriptions", subscriptionRouter);

router.use("/delegations",  delegationRoutes);
router.use("/regularisation/policies", regularisationPolicyRoutes);
router.use("/policy-versions", policyVersionRoutes);

// ── Biometric Integration ─────────────────────────────────────────────────
router.use("/biometric", biometricRoutes);

// ── Global Search ──────────────────────────────────────────────────────────
const searchRoutes = require("./modules/search/search.routes");
router.use("/search", searchRoutes);

module.exports = router;