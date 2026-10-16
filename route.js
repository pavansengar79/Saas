// route.js

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
const { authenticate: authMiddleware } = require("./middlewares/auth.middleware");
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

// Manual trigger for auto absent marker (Super Admin only)
router.post("/admin/jobs/auto-absent", authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== "SUPER_ADMIN" && req.user.role !== "unit_admin") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    const result = await runAutoAbsentMarker();
    res.json({ success: true, message: "Auto absent marker completed", data: result });
  } catch (err) { next(err); }
});
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

module.exports = router;
router.use("/delegations",  delegationRoutes);
router.use("/regularisation/policies", regularisationPolicyRoutes);
router.use("/policy-versions", policyVersionRoutes);

// ── Biometric Integration ─────────────────────────────────────────────────
router.use("/biometric", biometricRoutes);
const subscriptionRoutes = require("./modules/subscription/subscription.routes");
router.use("/subscription", subscriptionRoutes);

// ── Global Search ──────────────────────────────────────────────────────────
const searchRoutes = require("./modules/search/search.routes");
router.use("/search", searchRoutes);

module.exports = router;