const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// A-05: rate limiting is ON unless RATE_LIMIT_DISABLED=true is set (e.g. for load tests).
// It used to be hard-coded off (const isDisabled = "true").
const isDisabled = process.env.RATE_LIMIT_DISABLED === "true";
const passThrough = (req, res, next) => next();

// Common handler
const rateLimitHandler = (req, res) => {
  return res.status(429).json({
    success: false,
    message: "Too many attempts. Please wait 15 minutes and try again.",
    statusCode: 429
  });
};

// Login: 10 failed attempts per IP + email in 15 minutes. Successful logins are not counted.
// Accounts are also locked in the database after 5 wrong passwords (see auth.service.js),
// which still works when serverless instances do not share this in-memory counter.
const loginLimiter = isDisabled
  ? passThrough
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      skipSuccessfulRequests: true,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: req => `${ipKeyGenerator(req.ip || "")}:${String(req.body?.email || "").toLowerCase().trim()}`,
      handler: rateLimitHandler
    });

// Forgot / reset password
const authLimiter = isDisabled
  ? passThrough
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 5,
      standardHeaders: true,
      legacyHeaders: false,
      handler: rateLimitHandler
    });

// API Rate Limiter
const apiLimiter = isDisabled
  ? passThrough
  : rateLimit({
      windowMs: 60 * 1000,
      limit: 100,
      standardHeaders: true,
      legacyHeaders: false,
      handler: rateLimitHandler
    });

module.exports = {
  loginLimiter,
  authLimiter,
  apiLimiter
};
