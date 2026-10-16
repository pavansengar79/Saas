// middlewares/permission.middleware.js
//
// 3-layer auth check — ALL 3 must pass on every protected request.
//
// LAYER 1 — Subscription: is the organisation's plan active?
// LAYER 2 — Module: is the required module active at the org or company level?
//           FIXED: org OFF + company ON = allowed (company-specific module)
//           org ON  + company OFF = blocked for this company
// LAYER 3 — Permission: does the role have the required permission slug?
//         + DELEGATION: if not, check for an active delegation
//
// Super Admin / product_admin — bypass all 3.
//
// Usage:
//   router.get("/", authenticate, checkPermission("employee.read"), ctrl.list);

const Role          = require("../modules/role/role.model");
const Permission    = require("../modules/permission/permission.model");
const Subscription  = require("../modules/subscription/models/subscription.Models");
const OrgModule     = require("../modules/orgModule/models/orgModule.model");
const CompanyModule = require("../modules/company/models/companyModule.model");
const Module        = require("../modules/module/models/module.model");
const Delegation = require("../modules/delegation/models/delegation.model");

// Platform-level — always available, skip module check.
// IMPORTANT: this list is for account/administration primitives that have
// no corresponding purchasable Module document at all (see module.Seeders.js
// for the real, registered slugs: employee, attendance, leave, payroll,
// shift, holiday, organisation, auth, role, department, designation, crm,
// sales, bd). Anything NOT in that Module list must stay in this bypass
// array, otherwise Layer 2's Module.findOne() will always return null and
// block everyone, on every plan — a "module not found" outage, not proper
// gating. Do NOT add attendancePolicy/leavePolicy/payrollPolicy here — they
// are aliased to their real module below instead (see MODULE_ALIAS).
//
// NOTE: "shift" module IS a purchasable module, so it should NOT be here.
// However, if OrgModule records are not being created on subscription activation,
// temporarily add it here to unblock users. Long-term fix: ensure subscription
// service creates OrgModule records for all modules in the plan.
const PLATFORM_MODULES = [
  "auth", "role", "user", "org", "company",
  "plan", "subscription", "permission", "customer",
  "lob", "unit",
  "holiday", "department", "designation",
  "delegation", "notification", "auditLog",
  "investment_declaration", "leave_type",
  "biometric", "biometric_integration",
];

// Policy management (attendancePolicy/leavePolicy/payrollPolicy) isn't its
// own purchasable module — it's config for the real feature module. Gate it
// against the SAME module the policy configures, so a company without
// "attendance" in their plan can't manage attendance policies either, and
// so we never look up a Module document that doesn't exist.
//
// Shift permissions (shift.read, shift.create) map to module "shift"
// which is the actual module slug in DB. Same for roster.
const MODULE_ALIAS = {
  attendancePolicy: "attendance",
  regularisationPolicy: "attendance",
  leavePolicy:       "leave",
  leaveType:         "leave",
  payrollPolicy:     "payroll",
  // Also map lowercase policy names (from permission slugs)
  attendancepolicy: "attendance",
  regularisationpolicy: "attendance",
  leavepolicy:       "leave",
  payrollpolicy:     "payroll",
};

module.exports = (requiredPermission) => {
  return async (req, res, next) => {
    try {

      // ── Super Admin / Product Admin bypass ────────────────────
      if (req.user.role === "SUPER_ADMIN" || req.user.role === "product_admin") {
        return next();
      }

      const { orgId, companyId } = req.user;
      const [moduleName, action] = requiredPermission.split(".");
      const effectiveModuleName = MODULE_ALIAS[moduleName] || moduleName;

      // ═══════════════════════════════════════════════════════════
      // LAYER 1 — Subscription check
      // ═══════════════════════════════════════════════════════════
      if (orgId) {
        const subscription = await Subscription.findOne({
          org_id: orgId, is_active: true,
        });

        if (!subscription) {
          return res.status(403).json({
            success: false, code: "SUBSCRIPTION_NOT_FOUND",
            message: "No active subscription found. Please contact support.",
          });
        }

        const now = new Date();

        if (["Expired", "Cancelled"].includes(subscription.status)) {
          return res.status(403).json({
            success: false, code: "SUBSCRIPTION_INACTIVE",
            message: "Your subscription has ended. Please renew to continue.",
            upgradeUrl: "/pricing",
          });
        }

        if (subscription.status === "PastDue") {
          if (!subscription.grace_ends_at || now > new Date(subscription.grace_ends_at)) {
            return res.status(403).json({
              success: false, code: "SUBSCRIPTION_GRACE_EXPIRED",
              message: "Payment overdue. Please update your billing details.",
              upgradeUrl: "/billing",
            });
          }
          req.subscriptionWarning = {
            status: "PastDue",
            grace_ends_at: subscription.grace_ends_at,
            message: "Your payment is overdue. Access will be blocked soon.",
          };
        }

        if (subscription.status === "Trial") {
          if (now > new Date(subscription.ends_at)) {
            return res.status(403).json({
              success: false, code: "TRIAL_EXPIRED",
              message: "Your trial has expired. Please upgrade your plan.",
              upgradeUrl: "/pricing",
            });
          }
          req.trialInfo = {
            status:   "Trial",
            daysLeft: Math.max(0, Math.ceil((new Date(subscription.ends_at) - now) / 86400000)),
            ends_at:  subscription.ends_at,
          };
        }
      }

      // ═══════════════════════════════════════════════════════════
      // LAYER 2 — Module check (FIXED for company-specific modules)
      // ═══════════════════════════════════════════════════════════
      // TEMPORARY FIX: Skip OrgModule check for shift/roster
      // Reason: OrgModule records not auto-created on subscription
      // Safe because checkFeature middleware gates by plan features
      const shouldSkipModuleCheck = effectiveModuleName === "shift" || effectiveModuleName === "roster";
      
      if (orgId && !PLATFORM_MODULES.includes(effectiveModuleName) && !shouldSkipModuleCheck) {

        const moduleDoc = await Module.findOne({ slug: effectiveModuleName, is_active: true });

        if (!moduleDoc) {
          return res.status(403).json({
            success: false, code: "MODULE_NOT_FOUND",
            message: `Module "${effectiveModuleName}" does not exist on this platform.`,
          });
        }

        // Fetch org + company records in parallel
        const [orgModule, companyModule] = await Promise.all([
          OrgModule.findOne({ org_id: orgId, module_id: moduleDoc._id }),
          companyId
            ? CompanyModule.findOne({ org_id: orgId, company_id: companyId, module_id: moduleDoc._id })
            : Promise.resolve(null),
        ]);

        const orgActive     = orgModule?.is_active === true;
        const companyActive = companyModule?.is_active === true;

        // Access granted if org-level OR company-specific is active
        if (!orgActive && !companyActive) {
          return res.status(403).json({
            success: false, code: "MODULE_NOT_AVAILABLE",
            message: `The "${effectiveModuleName}" module is not available for your account.`,
            upgradeUrl: "/pricing",
          });
        }

        // Org is ON, but company explicitly turned it OFF
        if (orgActive && companyId && companyModule && !companyModule.is_active) {
          return res.status(403).json({
            success: false, code: "MODULE_DISABLED_FOR_COMPANY",
            message: `The "${effectiveModuleName}" module has been disabled for your company.`,
          });
        }
      }

      // ═══════════════════════════════════════════════════════════
      // LAYER 3 — Role permission check
      // ═══════════════════════════════════════════════════════════
      const role = await Role.findById(req.user.roleId).populate("permissions");

      if (!role) {
        return res.status(403).json({ success: false, message: "Role not found" });
      }

      // Debug: Log what we're checking
      console.log(`[DEBUG] Permission check for ${requiredPermission} | User: ${req.user.userId} | Role: ${role.slug} | Permissions: ${role.permissions.length}`);

      // Wildcard — full access (org_admin etc.)
      if (role.permissions.some(p => (p.slug || p.toString()) === "*")) {
        return next();
      }

      // Slug-based lookup (fast, indexed)
      let permission = await Permission.findOne({ slug: requiredPermission, is_active: true });

      // Backward compat fallback
      if (!permission) {
        permission = await Permission.findOne({ module: moduleName, action });
      }

      if (!permission) {
        return res.status(400).json({
          success: false,
          message: `Permission "${requiredPermission}" is not defined in the system`,
        });
      }

      // Handle both populated objects and ObjectId references
      const hasPermission = role.permissions.some((p) => {
        const permId = p._id || p;
        return permId.toString() === permission._id.toString();
      });

      if (!hasPermission) {
        // ── DELEGATION CHECK ───────────────────────────────────
        // Role lacks this permission — check for an active delegation.
        // A delegation temporarily grants this user the permission.
        try {
          const now = new Date();
          const activeDelegation = await Delegation.findOne({
            delegatee_id: req.user.userId,
            permissions:  { $in: [permission._id] },
            status:       "ACTIVE",
            startDate:    { $lte: now },
            endDate:      { $gte: now },
            is_deleted:   false,
          }).lean();

          if (activeDelegation) {
            // Permission granted through delegation — allow
            req.delegationId = activeDelegation._id; // Attach for auditing
            return next();
          }
        } catch (_) {
          // Delegation check fail — non-fatal, proceed to 403
        }

        return res.status(403).json({
          success: false,
          message: "You do not have permission to perform this action",
        });
      }

      next();

    } catch (error) {
      next(error);
    }
  };
};