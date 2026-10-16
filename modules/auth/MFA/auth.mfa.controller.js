// const mfaService = require("./auth.mfa.service");
// const jwt        = require("../../../utils/jwt.utils");
// const AppError   = require("../../../utils/appError");


// // POST /api/v1/auth/mfa/enrol
// exports.enrol = async (req, res, next) => {
//   try {
//     const result = await mfaService.enrol(req.user.userId);
//     res.status(200).json({
//       success: true,
//       message: "Scan the QR code with your authenticator app",
//       data:    result,
//     });
//   } catch (error) {
//     next(error);
//   }
// };

// // POST /api/v1/auth/mfa/verify-enrolment
// exports.verifyEnrolment = async (req, res, next) => {
//   try {
//     const { token } = req.body;
//     if (!token) return next(new (require("../../utils/appError"))("OTP token is required", 400));

//     const result = await mfaService.verifyEnrolment(req.user.userId, token);

//     res.status(200).json({
//       success: true,
//       message: result.message,
//       data: {
//         backupCodes: result.backupCodes,
//         warning: "Save these backup codes now. They will not be shown again.",
//       },
//     });
//   } catch (error) {
//     next(error);
//   }
// };

// // POST /api/v1/auth/mfa/challenge
// // Submit an OTP after login to receive a full JWT
// exports.challenge = async (req, res, next) => {
//   try {
//       const { mfaToken, token } = req.body; // ✅ No userId

//     if (!mfaToken || !token) {
//       return next(new AppError("mfaToken and OTP are required", 400));
//     }

//     // Decode the mfaToken
//     let decoded;
//     try {
//       decoded = jwt.verify(mfaToken, process.env.JWT_SECRET);
//     } catch {
//       return next(new AppError("MFA session expired. Please login again.", 401));
//     }

//     if (!decoded.mfaPending) {
//       return next(new AppError("Invalid MFA token", 400));
//     }
//     const result = await mfaService.verifyLoginChallenge(userId, token);

//     if (!result.verified) {
//       return next(new (require("../../utils/appError"))("Verification failed", 400));
//     }

//     // Verified — now generate a full JWT
//     // Fetch the user for the JWT payload
//     const User = require("./models/user.model");
//     const user = await User.findById(userId).populate("roleId", "slug name");

//     const fullToken = jwt.signToken({
//       userId:   user._id,
//       tenantId: user.tenantId,
//       roleId:   user.roleId._id,
//       role:     user.roleId.slug,
//     });

//     res.status(200).json({
//       success: true,
//       message: "MFA verified successfully",
//       data: {
//         token:  fullToken,
//         method: result.method,
//         ...(result.remainingBackups !== undefined && {
//           remainingBackupCodes: result.remainingBackups,
//         }),
//       },
//     });
//   } catch (error) {
//     next(error);
//   }
// };

// // POST /api/v1/auth/mfa/disable
// exports.disable = async (req, res, next) => {
//   try {
//     const { token } = req.body;
//     if (!token) return next(new (require("../../utils/appError"))("OTP token is required", 400));

//     const result = await mfaService.disable(req.user.userId, token);
//     res.status(200).json({ success: true, message: result.message });
//   } catch (error) {
//     next(error);
//   }
// };

// // POST /api/v1/auth/mfa/backup-codes/regenerate
// exports.regenerateBackupCodes = async (req, res, next) => {
//   try {
//     const { token } = req.body;
//     if (!token) return next(new (require("../../utils/appError"))("OTP token is required", 400));

//     const result = await mfaService.regenerateBackupCodes(req.user.userId, token);
//     res.status(200).json({
//       success: true,
//       message: result.message,
//       data: {
//         backupCodes: result.backupCodes,
//         warning: "Save these backup codes now. They will not be shown again.",
//       },
//     });
//   } catch (error) {
//     next(error);
//   }
// };

// // GET /api/v1/auth/mfa/status
// exports.getStatus = async (req, res, next) => {
//   try {
//     const result = await mfaService.getStatus(req.user.userId);
//     res.status(200).json({ success: true, data: result });
//   } catch (error) {
//     next(error);
//   }
// };


const mfaService    = require("./auth.mfa.service");
const { verifyToken, generateToken } = require("../../../utils/jwt.utils"); // ✅ correct import
const AppError      = require("../../../utils/appError");
const User          = require("../models/user.model"); // ✅ Import at the top
const Employee      = require("../../employee/models/employee.model");
const Permission    = require("../../permission/permission.model");
const Subscription  = require("../../subscription/models/subscription.Models");
const Organization  = require("../../organisation/models/organization.model");
const Company       = require("../../company/models/company.model");

// ── Plan modules → permission module mapping ──────────────────
const MODULE_MAP = {
  employee:      ["employee"],
  attendance:    ["attendance"],
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

// POST /api/v1/auth/mfa/enrol
exports.enrol = async (req, res, next) => {
  try {
    const result = await mfaService.enrol(req.user.userId);
    res.status(200).json({
      success: true,
      message: "Scan the QR code with your authenticator app",
      data:    result,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/mfa/verify-enrolment
exports.verifyEnrolment = async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return next(new AppError("OTP token is required", 400)); // ✅

    const result = await mfaService.verifyEnrolment(req.user.userId, token);
    res.status(200).json({
      success: true,
      message: result.message,
      data: {
        backupCodes: result.backupCodes,
        warning: "Save these backup codes now. They will not be shown again.",
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/mfa/challenge
exports.challenge = async (req, res, next) => {
  try {
    const { mfaToken, token } = req.body;

    if (!mfaToken || !token) {
      return next(new AppError("mfaToken and OTP are required", 400));
    }

    // ✅ Use verifyToken instead of jwt.verify
    let decoded;
    try {
      decoded = verifyToken(mfaToken);
    } catch {
      return next(new AppError("MFA session expired. Please login again.", 401));
    }

    if (!decoded.mfaPending) {
      return next(new AppError("Invalid MFA token", 400));
    }

    const userId = decoded.userId; // ✅ Extract from decoded token

    const result = await mfaService.verifyLoginChallenge(userId, token);

    if (!result.verified) {
      return next(new AppError("Verification failed", 400));
    }

    // ── Fetch complete user data matching normal login flow ─────────
    const user = await User.findById(userId)
      .populate({
        path: "roleId",
        select: "name slug level permissions",
        populate: { path: "permissions", select: "name slug module" },
      });

    if (!user) {
      return next(new AppError("User not found", 404));
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

    const fullToken = generateToken({
      userId:         user._id,
      org_id:         user.org_id     || null,
      company_id:     user.company_id || null,
      unit_id:        user.unit_id    || null,
      roleId:         user.roleId._id,
      role:           user.roleId.slug,
      level:          user.roleId.level,
      is_first_login: user.is_first_login || false,
    });

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
      const Unit = require("../../unit/models/unit.model");
      unit = await Unit.findById(user.unit_id)
        .select("name unit_code location")
        .lean();
    }

    res.status(200).json({
      success: true,
      message: "MFA verified successfully",
      data: {
        token:  fullToken,
        is_first_login: user.is_first_login || false,
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
        method: result.method,
        ...(result.remainingBackups !== undefined && {
          remainingBackupCodes: result.remainingBackups,
        }),
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/mfa/disable
exports.disable = async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return next(new AppError("OTP token is required", 400)); // ✅

    const result = await mfaService.disable(req.user.userId, token);
    res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/auth/mfa/backup-codes/regenerate
exports.regenerateBackupCodes = async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return next(new AppError("OTP token is required", 400)); // ✅

    const result = await mfaService.regenerateBackupCodes(req.user.userId, token);
    res.status(200).json({
      success: true,
      message: result.message,
      data: {
        backupCodes: result.backupCodes,
        warning: "Save these backup codes now. They will not be shown again.",
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/auth/mfa/status
exports.getStatus = async (req, res, next) => {
  try {
    const result = await mfaService.getStatus(req.user.userId);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};