const jwt          = require("jsonwebtoken");
const bcrypt       = require("bcryptjs");
const AppError     = require("../../utils/appError");
const User         = require("../auth/models/user.model");
const Employee     = require("../employee/models/employee.model");
const Permission   = require("../permission/permission.model");
const Role         = require("../role/role.model");
const Subscription = require("../subscription/models/subscription.Models");
const sendEmail    = require("../../utils/email/email").sendEmail;
const { forgotPasswordTemplate } = require("../../utils/email/templates/forgetPassword");
const Customer = require("../customer/models/customer.model");
const Organization = require("../organisation/models/organization.model");
const Company = require("../company/models/company.model");
const Unit = require("../unit/models/unit.model");

// ── Plan modules → permission module mapping ──────────────────
const MODULE_MAP = {
  employee:      ["employee"],
  attendance:    ["attendance", "attendancePolicy", "regularisationPolicy"],
  leave:         ["leave"],
  payroll:       ["payroll"],
  organisation:  ["organisation", "org", "lob", "unit", "company"],
  auth:          ["role", "user", "department", "designation",
                  "holiday", "leavePolicy", "attendancePolicy",
                  "payrollPolicy", "subscription", "plan"],
  shift:         ["shift", "roster"],
  roster:        ["shift", "roster"],
  shift_roster:  ["shift", "roster"],
  delegation:    ["delegation"],
  audit_trail:   ["auditLog", "audit"],
  notifications: ["notification"],
  biometric:     ["biometric"],
  leavePolicy:        ["leavePolicy"],
  attendancePolicy:   ["attendancePolicy"],
  regularisationPolicy: ["regularisationPolicy"],
  payrollPolicy:      ["payrollPolicy"],
  holiday:            ["holiday"],
  department:         ["department"],
  designation:        ["designation"],
};

const filterPermissions = (permissions, subscription) => {
  const planModules  = subscription?.plan_snapshot?.modules  || [];
  const planFeatures = subscription?.plan_snapshot?.features || [];
  const activeModules = [...new Set([...planModules, ...planFeatures])];
  const allowedModules = activeModules.flatMap(s => MODULE_MAP[s] || []);
  
  // Always include biometric module (core HRMS feature)
  if (!allowedModules.includes("biometric")) {
    allowedModules.push("biometric");
  }

    if (!allowedModules.includes("account")) {
    allowedModules.push("account");
  }
  
  
  return permissions.filter(p => allowedModules.includes(p.module));
};

// Role display name — based on plan structure_level
const getRoleDisplayName = (roleSlug, structureLevel) => {
  if (roleSlug !== "org_admin") return undefined;
  if (structureLevel === "unit")        return "Account Admin";
  if (structureLevel === "company")     return "Company Admin";
  if (structureLevel === "enterprise")  return "Org Admin";
  return "Admin";
};

// ─────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

exports.login = async (payload) => {
  const { email, password } = payload;

  // ── Super Admin ───────────────────────────────────────────
  if (email === process.env.SUPER_ADMIN_EMAIL) {
    if (password !== process.env.SUPER_ADMIN_PASSWORD) {
      throw new AppError("Invalid credentials", 401);
    }

    const token = jwt.sign(
      { email, role: "SUPER_ADMIN", type: "SYSTEM", org_id: null, userId: null },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    const allPermissions = await Permission.find({}, "name slug module");

    return {
      token,
      user: {
        id:   null,
        name: "Super Admin",
        email,
        role: { name: "Super Admin", slug: "super_admin", permissions: allPermissions },
      },
    };
  }

  // ── Regular user first ───────────────────────────────────
  const user = await User.findOne({ email, is_deleted: false })
    .select("+password -refreshTokens")
    .populate({
      path:     "roleId",
      select:   "name slug level permissions",
      populate: { path: "permissions", select: "name slug module" },
    });

  if (user) {
    if (user.status !== "ACTIVE") throw new AppError("Account not active", 403);

    // Safety net — even if User.status somehow stayed ACTIVE while the
    // linked Employee was terminated (a sync miss elsewhere), a terminated
    // employee must never be able to log in. This check is independent of
    // wherever Employee.status gets set, so it can't be bypassed by a
    // missed sync in some other code path.
    const terminatedEmployee = await Employee.findOne({
      userId: user._id,
      status: "TERMINATED",
    }).select("_id").lean();
    if (terminatedEmployee) throw new AppError("Account not active", 403);

    // ── A-05: lock the account after repeated wrong passwords ──
    if (user.lockUntil && user.lockUntil > new Date()) {
      const minutes = Math.ceil((user.lockUntil - new Date()) / 60000);
      throw new AppError(`Too many failed login attempts. Try again in ${minutes} minute(s) or reset your password.`, 429);
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const attempts = (user.loginAttempts || 0) + 1;
      const locked = attempts >= MAX_LOGIN_ATTEMPTS;
      await User.updateOne(
        { _id: user._id },
        locked
          ? { $set: { loginAttempts: 0, lockUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } }
          : { $set: { loginAttempts: attempts } }
      );
      if (locked) {
        throw new AppError(`Too many failed login attempts. Your account is locked for ${LOCK_MINUTES} minutes.`, 429);
      }
      throw new AppError("Invalid credentials", 401);
    }
    if (user.loginAttempts || user.lockUntil) {
      await User.updateOne({ _id: user._id }, { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } });
    }

    // ── MFA check ───────────────────────────────────────────
    if (user.mfaEnabled) {
      const mfaPendingToken = jwt.sign(
        { userId: user._id, mfaPending: true },
        process.env.JWT_SECRET,
        { expiresIn: "5m" }
      );
      return { mfaRequired: true, mfaToken: mfaPendingToken };
    }

    // ── Subscription ────────────────────────────────────────
    const subscriptionRootId = user.org_id || user.company_id || user.unit_id || null;
    const subscription = subscriptionRootId
      ? await Subscription.findOne({ org_id: subscriptionRootId, is_active: true }).lean()
      : null;

    const daysLeft = subscription?.ends_at
      ? Math.max(0, Math.ceil((new Date(subscription.ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
      : null;

    const structureLevel = subscription?.plan_snapshot?.structure_level || null;

    const filteredPerms = filterPermissions(user.roleId.permissions, subscription);

    const token = jwt.sign(
      {
        userId:         user._id,
        org_id:         user.org_id     || null,
        company_id:     user.company_id || null,
        unit_id:        user.unit_id    || null,
        roleId:         user.roleId._id,
        role:           user.roleId.slug,
        level:          user.roleId.level,
        is_first_login: user.is_first_login,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    // ── Find Employee record for this user ─────────────────────
    const employee = await Employee.findOne({ userId: user._id }).select("_id profilePhoto").lean();

    // ── Fetch Organization, Company, and Unit details ────────────────────
    let organization = null;
    let company = null;
    let unit = null;

    if (user.org_id) {
      organization = await Organization.findById(user.org_id)
        .select("name logo_url address timezone currency")
        .lean();
    }

    if (user.company_id) {
      company = await Company.findById(user.company_id)
        .select("company_name logo_url company_pan company_gst address")
        .lean();
    }

    if (user.unit_id) {
      const Unit = require("../unit/models/unit.model");
      unit = await Unit.findById(user.unit_id)
        .select("name unit_code location")
        .lean();
    }

    return {
      token,
      is_first_login: user.is_first_login,
      user: {
        _id:             employee?._id || null,  // Employee _id for profile redirect
        id:              user._id,
        name:            user.name,
        email:           user.email,
        phone:           user.phone,
        profilePhoto:    employee?.profilePhoto || null,  // Employee DP
        orgLogo:         organization?.logo_url || null,    // Organization logo
        companyLogo:     company?.logo_url || null, // Company logo
        org_id:          user.org_id     || null,
        company_id:      user.company_id || null,
        unit_id:         user.unit_id    || null,
        status:          user.status,
        isEmailVerified: user.isEmailVerified,
        // ── Populated organization, company, unit for dashboard ──
        organization:    organization || null,
        company:         company || null,
        unit:            unit || null,
        role: {
          id:           user.roleId._id,
          name:         user.roleId.name,
          slug:         user.roleId.slug,
          level:        user.roleId.level,
          display_name: getRoleDisplayName(user.roleId.slug, structureLevel),
          permissions:  filteredPerms,
        },
      },
      subscription: subscription
        ? {
            status:          subscription.status,
            plan_name:       subscription.plan_snapshot?.name           || null,
            structure_level: structureLevel,
            features: subscription.plan_snapshot?.features || [],
            ends_at:         subscription.ends_at,
            days_left:       daysLeft,
            is_trial:        subscription.status === "Trial",
          }
        : null,
    };
  }

  // ── Customer afterward ────────────────────────────────────
  const customer = await Customer.findOne({
    contact_email: email.toLowerCase().trim(),
    is_deleted:    false,
    status:        "Active",
    }).select("+password").populate("plan_id", "name slug features structure_level package_type price_monthly");

  if (customer) {
    const isMatch = await bcrypt.compare(password, customer.password);
    if (!isMatch) throw new AppError("Invalid credentials", 401);

    const token = jwt.sign(
      {
        customerId:     customer._id,
        email:          customer.contact_email,
        role:           "customer",
        is_first_login: customer.is_first_login,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    return {
      token,
      is_first_login: customer.is_first_login,
      user: {
        id:            customer._id,
        name:          customer.contact_name,
        email:         customer.contact_email,
        business_name: customer.business_name,
        role:          { slug: "customer", name: "Customer" },
      },
       plan: customer.plan_id ? {
        id:              customer.plan_id._id,
        name:            customer.plan_id.name,
        slug:            customer.plan_id.slug,
        features:        customer.plan_id.features,
        structure_level: customer.plan_id.structure_level,
        package_type:    customer.plan_id.package_type,
        price_monthly:   customer.plan_id.price_monthly,
    } : null,
    subscription: null,
    };
  }

  // No matching account found
  throw new AppError("Invalid credentials", 401);
};

// ─────────────────────────────────────────────────────────────
// GET ME
// ─────────────────────────────────────────────────────────────
exports.getMe = async (user) => {

  // ── Super Admin ───────────────────────────────────────────
  if (user.role === "SUPER_ADMIN") {
    const allPermissions = await Permission.find({}, "name slug module");
    return {
      user: {
        id:    null,
        name:  "Super Admin",
        email: user.email,
        role:  { name: "Super Admin", slug: "super_admin", permissions: allPermissions },
      },
      subscription: null,
    };
  }

  // ── Regular user ──────────────────────────────────────────
  const currentUser = await User.findOne({ _id: user.userId, is_deleted: false })
    .populate({
      path:     "roleId",
      populate: { path: "permissions", select: "name slug module" },
    })
    .select("-password -refreshTokens -__v -loginAttempts");

  if (!currentUser) throw new AppError("User not found", 404);

  const rootId = currentUser.org_id || currentUser.company_id || currentUser.unit_id;
  const subscription = rootId
    ? await Subscription.findOne({ org_id: rootId, is_active: true }).lean()
    : null;

  const daysLeft = subscription?.ends_at
    ? Math.max(0, Math.ceil((new Date(subscription.ends_at) - new Date()) / (1000 * 60 * 60 * 24)))
    : null;

  const structureLevel = subscription?.plan_snapshot?.structure_level || null;

  // Refresh responses need hierarchy details to rebuild the client context.
  const [organization, company, unit] = await Promise.all([
    currentUser.org_id
      ? Organization.findById(currentUser.org_id)
          .select("name logo_url address timezone currency")
          .lean()
      : null,
    currentUser.company_id
      ? Company.findById(currentUser.company_id)
          .select("company_name logo_url company_pan company_gst address")
          .lean()
      : null,
    currentUser.unit_id
      ? Unit.findById(currentUser.unit_id)
          .select("name unit_code location")
          .lean()
      : null,
  ]);

  // ── Filter permissions by plan modules ────────────────────
  const filteredPerms = filterPermissions(currentUser.roleId.permissions, subscription);

  // ── Find Employee record for this user ─────────────────────
  const employee = await Employee.findOne({ userId: currentUser._id }).select("_id profilePhoto").lean();

  return {
    user: {
      id:              currentUser._id,
      employeeId:      employee?._id || null,  // Employee document ID for profile navigation
      name:            currentUser.name,
      email:           currentUser.email,
      phone:           currentUser.phone,
      profilePhoto:    employee?.profilePhoto || null,  // Employee DP
      org_id:          currentUser.org_id     || null,
      company_id:      currentUser.company_id || null,
      unit_id:         currentUser.unit_id    || null,
      organization:    organization || null,
      company:         company || null,
      unit:            unit || null,
      is_first_login:  currentUser.is_first_login,
      isEmailVerified: currentUser.isEmailVerified,
      status:          currentUser.status,
      role: {
        id:           currentUser.roleId._id,
        name:         currentUser.roleId.name,
        slug:         currentUser.roleId.slug,
        level:        currentUser.roleId.level,
        display_name: getRoleDisplayName(currentUser.roleId.slug, structureLevel),
        permissions:  filteredPerms,
      },
    },
    subscription: subscription
      ? {
          status:          subscription.status,
          plan_name:       subscription.plan_snapshot?.name           || null,
          structure_level: structureLevel,
          modules:         subscription.plan_snapshot?.modules        || [],
          ends_at:         subscription.ends_at,
          days_left:       daysLeft,
          is_trial:        subscription.status === "Trial",
        }
      : null,
  };
};

// ─────────────────────────────────────────────────────────────
// FORGOT PASSWORD
// ─────────────────────────────────────────────────────────────
exports.forgotPassword = async (email) => {
  if (email === process.env.SUPER_ADMIN_EMAIL) {
    return { message: "If this email exists, a reset link has been sent." };
  }

  const user = await User.findOne({ email, is_deleted: false });
  if (!user) return { message: "If this email exists, a reset link has been sent." };

  if (user.status === "INACTIVE" || user.status === "BLOCKED") {
    throw new AppError("Account is not active", 403);
  }

  const resetToken = jwt.sign(
    { userId: user._id, type: "PASSWORD_RESET" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  const resetLink = `${process.env.GOOGLE_FRONTEND_REDIRECT_URI}/auth/reset-password?token=${resetToken}`;

  try {
    await sendEmail({
      to:      email,
      subject: "Reset Your HRMS Password",
      html:    forgotPasswordTemplate({ name: user.name, resetLink }),
    });
  } catch (emailError) {
    console.error("Reset email failed:", emailError);
    throw new AppError("Failed to send reset email. Please try again.", 500);
  }

  return { message: "If this email exists, a reset link has been sent." };
};

// ─────────────────────────────────────────────────────────────
// RESET PASSWORD
// ─────────────────────────────────────────────────────────────
exports.resetPassword = async (token, password) => {
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new AppError("Invalid or expired reset link", 400);
  }

  if (decoded.type !== "PASSWORD_RESET") throw new AppError("Invalid reset token", 400);

  const user = await User.findOne({ _id: decoded.userId, is_deleted: false }).select("+password");
  if (!user) throw new AppError("User not found", 404);

  if (user.status === "INACTIVE" || user.status === "BLOCKED") {
    throw new AppError("Account is not active", 403);
  }

  user.password = await bcrypt.hash(password, 10);
  await user.save();

  return { message: "Password reset successfully. Please login with your new password." };
};

exports.updateProfile = async (userId, updates) => {
  const user = await User.findByIdAndUpdate(userId, updates, { new: true }).select("-password");
  if (!user) throw new AppError("User not found", 404);
  return user;
};