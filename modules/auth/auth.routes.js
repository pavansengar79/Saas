const express = require('express');
const authController = require('./auth.controller');
const authMiddleware = require('../../middlewares/auth.middleware');
const authLimiter = require("../../middlewares/rateLimiter.middleware").authLimiter;
const router = express.Router();
const validate = require("../../middlewares/validate.middleware");
const { superAdminLoginSchema } = require("../../validations/auth.validations");
const { tenantLoginSchema } = require("../../validations/auth.validations");


// router.post("/super-admin/login", authLimiter, validate(superAdminLoginSchema), authController.superAdminLogin);
// router.post("/tenant/login",authLimiter,validate(tenantLoginSchema),authController.tenantlogin);
router.post("/login", validate(tenantLoginSchema), authController.login);
const passport = require("passport");
const { authenticate } = require("../../middlewares/auth.middleware");
// Google OAuth start
// router.get("/google",
//   passport.authenticate("google", {
//     scope: ["email", "profile"],
//     session: false
//   })
// );
// auth.routes.js
router.get("/google", (req, res, next) => {
  const returnUrl = req.query.returnUrl
   // ✅ Valid URL check
  const isValidUrl = returnUrl && returnUrl.startsWith("http");
  const state = isValidUrl 
    ? returnUrl 
    : process.env.GOOGLE_FRONTEND_REDIRECT_URI;

  console.log("returnUrl from frontend:", returnUrl);  // debug
  passport.authenticate("google", {
    scope:   ["email", "profile"],
    session: false,
    state:   returnUrl  // ✅ Pass returnUrl as the state parameter
  })(req, res, next);
});

router.get("/me", authenticate, authController.getMe);

// Google callback
router.get("/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: `${process.env.GOOGLE_FRONTEND_REDIRECT_URI}/login?error=google_failed`
  }),
  authController.googleCallback
);
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

// Submit company details for a new user
router.post("/complete-registration", authController.completeRegistration);
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