const express = require('express');
const authController = require('./auth.controller');
const authMiddleware = require('../../middlewares/auth.middleware');
const { authLimiter, loginLimiter } = require("../../middlewares/rateLimiter.middleware");
const router = express.Router();
const validate = require("../../middlewares/validate.middleware");
const { superAdminLoginSchema } = require("../../validations/auth.validations");
const { tenantLoginSchema } = require("../../validations/auth.validations");


// router.post("/super-admin/login", authLimiter, validate(superAdminLoginSchema), authController.superAdminLogin);
// router.post("/tenant/login",authLimiter,validate(tenantLoginSchema),authController.tenantlogin);
router.post("/login", loginLimiter, validate(tenantLoginSchema), authController.login);
const passport = require("passport");
const { authenticate } = require("../../middlewares/auth.middleware");
const { resolveCallbackUrl, buildRedirect } = require("./google.redirect");
router.get("/google", (req, res, next) => {
  passport.authenticate("google", {
    scope:   ["email", "profile"],
    session: false,
    state:   resolveCallbackUrl(req.query.returnUrl)
  })(req, res, next);
});

router.get("/me", authenticate, authController.getMe);

router.get("/google/callback", (req, res, next) => {
  const callbackUrl = resolveCallbackUrl(req.query.state);
  if (req.query.error) {
    return res.redirect(buildRedirect(callbackUrl, { error: "Google sign-in was cancelled or failed" }));
  }

  passport.authenticate("google", { session: false }, (error, googleUser, info) => {
    if (error) {
      console.error("[Google OAuth] callback failed:", error);
      return res.redirect(buildRedirect(callbackUrl, { error: "Google sign-in failed. Please try again." }));
    }
    if (!googleUser) {
      return res.redirect(buildRedirect(callbackUrl, { error: info?.message || "Google sign-in failed" }));
    }
    req.user = googleUser;
    req.googleCallbackUrl = callbackUrl;
    return authController.googleCallback(req, res, next);
  })(req, res, next);
});
const forgotPasswordSchema = require("../../validations/auth.validations").forgotPasswordSchema;
const resetPasswordSchema = require("../../validations/auth.validations").resetPasswordSchema;

// ─── Task 17 — Set password on first login ────────────────────
// Requires a valid JWT (user must login with temp password first)
// Body: { newPassword: string }
const setPasswordController = require("./auth.setPassword.controller");
router.post("/set-password", authenticate, setPasswordController.setPassword);

// ─── Change Password (authenticated user) ──────────────────────
// Body: { currentPassword: string, newPassword: string }
const changePasswordController = require("./auth.changePassword.controller");
const { changePasswordSchema } = require("../../validations/auth.validations");
router.post("/change-password", authenticate, validate(changePasswordSchema), changePasswordController.changePassword);

// Google accounts without an HRMS user use public registration instead.
router.patch("/me", authenticate, authController.updateMe);

router.post(
  "/forgot-password",
  authLimiter,
  validate(forgotPasswordSchema),
  authController.forgotPassword
);

router.post(
  "/reset-password",
  authLimiter,
  validate(resetPasswordSchema),
  authController.resetPassword
);
module.exports = router;