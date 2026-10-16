// middlewares/requestLogger.middleware.js
// 
// Logs every request:
//   → Method, URL, Status, Response Time
//   → User info (userId, role, level)
//   → Query params + Request body (with passwords masked)
//   → Error responses
//
// Usage in app.js:
//   const requestLogger = require('./middlewares/requestLogger.middleware')
//   app.use(requestLogger)
//   // Add before routes

"use strict";

const SENSITIVE_FIELDS = ["password", "newPassword", "confirmPassword", "token", "mfaSecret"];

// Mask sensitive fields
const maskBody = (body) => {
  if (!body || typeof body !== "object") return body;
  const masked = { ...body };
  SENSITIVE_FIELDS.forEach((field) => {
    if (masked[field]) masked[field] = "***";
  });
  return masked;
};

// Color codes for terminal
const COLORS = {
  reset:  "\x1b[0m",
  bright: "\x1b[1m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  blue:   "\x1b[34m",
  gray:   "\x1b[90m",
  magenta:"\x1b[35m",
};

const statusColor = (status) => {
  if (status >= 500) return COLORS.red;
  if (status >= 400) return COLORS.yellow;
  if (status >= 300) return COLORS.cyan;
  if (status >= 200) return COLORS.green;
  return COLORS.reset;
};

const methodColor = (method) => {
  const map = {
    GET:    COLORS.green,
    POST:   COLORS.cyan,
    PUT:    COLORS.yellow,
    PATCH:  COLORS.magenta,
    DELETE: COLORS.red,
  };
  return map[method] || COLORS.reset;
};

module.exports = (req, res, next) => {
  const start = Date.now();

  // Log when the response finishes
  res.on("finish", () => {
    const duration  = Date.now() - start;
    const status    = res.statusCode;
    const method    = req.method;
    const url       = req.originalUrl || req.url;
    const timestamp = new Date().toISOString();

    // User info from JWT (set after authentication middleware runs)
    const user      = req.user;
    const userId    = user?.userId    || "—";
    const role      = user?.role      || "—";
    const level     = user?.level     || "—";
    const orgId     = user?.orgId     ? user.orgId.toString().slice(-6) : "—";
    const companyId = user?.companyId ? user.companyId.toString().slice(-6) : "—";
    const unitId    = user?.unitId    ? user.unitId.toString().slice(-6) : "—";

    // Query params
    const query     = Object.keys(req.query).length
      ? JSON.stringify(req.query)
      : "";

    // Request body (only for mutating methods)
    const body = ["POST", "PUT", "PATCH"].includes(method) && req.body
      ? JSON.stringify(maskBody(req.body))
      : "";

    // ── Main log line ─────────────────────────────────────────
    console.log(
      `${COLORS.gray}${timestamp}${COLORS.reset} ` +
      `${methodColor(method)}${COLORS.bright}${method.padEnd(7)}${COLORS.reset}` +
      `${statusColor(status)}${status}${COLORS.reset} ` +
      `${COLORS.bright}${url}${COLORS.reset} ` +
      `${COLORS.gray}${duration}ms${COLORS.reset}`
    );

    // ── User context ──────────────────────────────────────────
    if (user) {
      console.log(
        `${COLORS.gray}  👤 userId: ${userId} | role: ${COLORS.cyan}${role}${COLORS.reset}` +
        `${COLORS.gray} | level: ${level}` +
        ` | org: ...${orgId}` +
        (user.companyId ? ` | co: ...${companyId}` : "") +
        (user.unitId    ? ` | unit: ...${unitId}` : "") +
        `${COLORS.reset}`
      );
    }

    // ── Query params ──────────────────────────────────────────
    if (query) {
      console.log(`${COLORS.gray}  🔍 Query: ${query}${COLORS.reset}`);
    }

    // ── Request body ──────────────────────────────────────────
    if (body && body !== "{}") {
      console.log(`${COLORS.gray}  📦 Body:  ${body}${COLORS.reset}`);
    }

    // ── Error highlight ───────────────────────────────────────
    if (status >= 400) {
      console.log(
        `${statusColor(status)}  ⚠️  ${status >= 500 ? "SERVER ERROR" : "CLIENT ERROR"} — ${method} ${url}${COLORS.reset}`
      );
    }

    // ── Divider for readability ───────────────────────────────
    console.log(`${COLORS.gray}  ${"─".repeat(60)}${COLORS.reset}`);
  });

  next();
};