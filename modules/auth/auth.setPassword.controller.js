// modules/auth/auth.setPassword.controller.js
//
// Task 17 — NEW
//
// Thin controller — all logic lives in auth.setPassword.service.js

const setPasswordService = require("./auth.setPassword.service");

// POST /auth/set-password
// Middleware: authenticate  (JWT required — req.user.userId must be set)
exports.setPassword = async (req, res, next) => {
  try {
    const { newPassword } = req.body;
    const userId          = req.user.userId;

    // A-03: customer portal tokens carry customerId (no userId)
    if (!userId && req.user.role === "customer" && req.user.customerId) {
      const result = await setPasswordService.setCustomerPassword(req.user.customerId, newPassword);
      return res.status(200).json({ success: true, message: result.message });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const result = await setPasswordService.setPassword(userId, newPassword);

    return res.status(200).json({
      success: true,
      message: result.message,
    });

  } catch (error) {
    next(error);
  }
};