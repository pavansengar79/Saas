const express       = require("express");
const router        = express.Router();
const mfaController = require("./auth.mfa.controller");
const { authenticate } = require("../../../middlewares/auth.middleware"); // ✅

// ─── Public route — challenge after login (no token yet) ─────────────
// Submit userId and OTP to receive a full JWT
router.post("/challenge", mfaController.challenge);

// ─── Protected routes — for authenticated users ───────────────────────────────
router.use(authenticate);

router.get ("/status",                    mfaController.getStatus);
router.post("/enrol",                     mfaController.enrol);
router.post("/verify-enrolment",          mfaController.verifyEnrolment);
router.post("/disable",                   mfaController.disable);
router.post("/backup-codes/regenerate",   mfaController.regenerateBackupCodes);

module.exports = router;