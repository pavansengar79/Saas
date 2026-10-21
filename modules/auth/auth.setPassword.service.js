// modules/auth/auth.setPassword.service.js
//
// Task 17 — NEW
//
// Handles the first-login password change.
//
// ─── Why this exists ─────────────────────────────────────────
// Every admin created by the system (Org Admin, Company Admin,
// Unit Admin) receives a temporary password by email and has
// is_first_login: true on their User document.
//
// They cannot use the app until they call this endpoint.
// Once they set their own password, is_first_login flips false
// and they can log in normally from that point on.
//
// ─── Rules ───────────────────────────────────────────────────
// 1. Requires a valid JWT (authenticate middleware must run first)
// 2. is_first_login must be true — rejects if already false
// 3. New password must be >= 8 chars
// 4. New password must NOT match the current (temp) password
// 5. After save: is_first_login = false, refreshTokens cleared
// 6. Returns success — frontend redirects to /login
//    (user re-authenticates to get a fresh JWT with
//     is_first_login: false in the payload)

const bcrypt   = require("bcryptjs");
const User     = require("./models/user.model");
const Customer = require("../customer/models/customer.model");
const AppError = require("../../utils/appError");

const assertNewPassword = (newPassword) => {
  if (!newPassword || typeof newPassword !== "string") {
    throw new AppError("newPassword is required", 400);
  }
  if (newPassword.trim().length < 8) {
    throw new AppError("Password must be at least 8 characters", 400);
  }
};

exports.setPassword = async (userId, newPassword) => {
  assertNewPassword(newPassword);

  // Fetch user — include password field (select:false by default)
  const user = await User.findOne({ _id: userId, is_deleted: false }).select("+password");

  if (!user) {
    throw new AppError("User not found", 404);
  }

  // Guard: only allow if this is genuinely a first login
  if (user.is_first_login !== true) {
    throw new AppError(
      "Password has already been set. Use forgot-password to reset it.",
      400
    );
  }

  // Guard: new password must differ from current temp password
  const isSameAsTemp = await bcrypt.compare(newPassword, user.password);
  if (isSameAsTemp) {
    throw new AppError(
      "New password must be different from your temporary password",
      400
    );
  }

  // Hash and save
  user.password       = await bcrypt.hash(newPassword, 10);
  user.is_first_login = false;
  user.refreshTokens  = [];   // invalidate any existing sessions
  await user.save();

  return {
    message: "Password updated successfully. Please log in with your new password.",
  };
};

// A-03: first-login password change for the customer portal.
// Customer JWT = { customerId, role: "customer" } — no userId, no User document.
exports.setCustomerPassword = async (customerId, newPassword) => {
  assertNewPassword(newPassword);

  const customer = await Customer.findOne({ _id: customerId, is_deleted: false }).select("+password");
  if (!customer) throw new AppError("Customer not found", 404);

  if (customer.is_first_login !== true) {
    throw new AppError("Password has already been set. Use forgot-password to reset it.", 400);
  }

  if (customer.password && await bcrypt.compare(newPassword, customer.password)) {
    throw new AppError("New password must be different from your temporary password", 400);
  }

  customer.password       = await bcrypt.hash(newPassword, 10);
  customer.is_first_login = false;
  await customer.save();

  return {
    message: "Password updated successfully. Please log in with your new password.",
  };
};
