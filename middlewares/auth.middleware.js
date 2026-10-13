// middlewares/auth.middleware.js
//
// Task 13 — MODIFIED
//
// Changes from original:
//   After verifyToken, now explicitly attaches these fields to req.user:
//     req.user.orgId      — from JWT payload org_id
//     req.user.companyId  — from JWT payload company_id
//     req.user.unitId     — from JWT payload unit_id
//     req.user.level      — from JWT payload level (org/company/unit)
//     req.user.roleId     — from JWT payload roleId
//     req.user.role       — from JWT payload role slug (e.g. "org_admin")
//
// JWT payload structure (set at login in auth.service.js Task 16):
// {
//   userId:     user._id,
//   org_id:     user.org_id,      // null for Super Admin
//   company_id: user.company_id,  // null for Org Admin
//   unit_id:    user.unit_id,     // null for Org/Company Admin
//   roleId:     user.roleId,
//   role:       role.slug,        // e.g. "org_admin", "hr_manager"
//   level:      role.level,       // "org" | "company" | "unit"
// }
//
// All 3 middleware layers (permission.middleware) read from req.user.
// This is the single source of truth for the request context.

const { verifyToken } = require("../utils/jwt.utils");

exports.authenticate = async (req, res, next) => {
  try {

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token required"
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = verifyToken(token);

    // ─── Attach full context to req.user ──────────────────────
    // Keep all decoded fields AND add named aliases for clarity.
    // Middlewares and controllers use req.user.orgId (not req.user.org_id)
    // for consistency with the old codebase pattern.
    req.user = {
      ...decoded,

      // Scope aliases — used throughout all middlewares + services
      userId:    decoded.userId    || null,
      orgId:     decoded.org_id    || null,
      companyId: decoded.company_id || null,
      unitId:    decoded.unit_id   || null,

      // Role context
      roleId: decoded.roleId || null,
      role:   decoded.role   || null,  // slug e.g. "hr_manager"
      level:  decoded.level  || null,  // "org" | "company" | "unit"
    };

    // T-26 — JWT invalidation check for blocked users
    // Only check for tenant users (not SUPER_ADMIN)
    if (decoded.userId && decoded.role !== "SUPER_ADMIN") {
      const User = require("../modules/auth/models/user.model");
      const dbUser = await User.findById(decoded.userId)
        .select("blockedAt status is_deleted name email")
        .lean();

      if (!dbUser || dbUser.is_deleted) {
        return res.status(401).json({ success: false, message: "Account not found" });
      }

      if (dbUser.status === "BLOCKED") {
        // Check if JWT was issued before the block
        if (dbUser.blockedAt && decoded.iat && decoded.iat < Math.floor(dbUser.blockedAt.getTime() / 1000)) {
          return res.status(401).json({ success: false, message: "Account has been blocked. Please contact admin." });
        }
      }

      if (decoded.org_id) {
        const Organization = require("../modules/organisation/models/organization.model");
        const organization = await Organization.findById(decoded.org_id)
          .select("customer_id")
          .populate("customer_id", "status")
          .lean();

        if (organization?.customer_id?.status === "Suspended") {
          return res.status(401).json({ success: false, message: "Tenant is suspended" });
        }
      }

      // Attach name + email for audit logs
      req.user.name  = dbUser.name  || null;
      req.user.email = dbUser.email || null;
    }

    next();

  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token"
    });
  }
};