// src/middlewares/superAdminGuard.middleware.js
const AppError = require("../utils/appError");

// ─────────────────────────────────────────
// Helper: Extract client IP from request
// ─────────────────────────────────────────
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.connection?.socket?.remoteAddress ||
    "127.0.0.1"
  );
}

// ─────────────────────────────────────────
// Helper: Get allowed IPs from env
// ─────────────────────────────────────────
function getAllowedIps() {
  const ips = process.env.SUPER_ADMIN_ALLOWED_IPS;
  if (!ips) return [];
  return ips.split(",").map(ip => ip.trim()).filter(Boolean);
}

// ─────────────────────────────────────────
// Super Admin Guard
// Apply after authentication
// ─────────────────────────────────────────
// Checks:
//   1. role === "SUPER_ADMIN" (from JWT)
// ─────────────────────────────────────────

exports.superAdminGuard = (req, res, next) => {

  // ── Role check ─────────────────────
  if (!req.user || req.user.role !== "SUPER_ADMIN") {
    return next(new AppError("Access restricted", 403));
  }

  // ── 2. IP check — only in production and when explicitly
  //      configured. Vercel/serverless deployments have dynamic
  //      egress IPs, and admins often connect from non-static IPs too,
  //      so treating "not configured" as a hard block ends up locking
  //      out every super admin action (including just viewing a
  //      customer). Only enforce once an allowlist is actually set.
  if (process.env.NODE_ENV === "production") {
    const clientIp   = getClientIp(req);
    const allowedIps = getAllowedIps();

    if (allowedIps.length && !allowedIps.includes(clientIp)) {
      return next(new AppError("Access restricted", 403));
    }

    if (!allowedIps.length) {
      console.warn("[superAdminGuard] SUPER_ADMIN_ALLOWED_IPS not set — IP allowlisting is disabled.");
    }
  }

  next();
};