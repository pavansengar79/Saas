const authService = require("./auth.service");
const jwt = require("jsonwebtoken");
const User = require("./models/user.model");
const Tenant = require("../tenant/tenant.models");
const AppError = require("../../utils/appError");

// exports.superAdminLogin = async (req, res, next) => {
//   try {

//     const { email, password } = req.body;

//     const data = await authService.superAdminLogin(email, password);

//     return res.status(200).json({
//       success: true,
//       message: "Super admin login successful",
//       data
//     });

//   } catch (error) {
//     next(error);
//   }
// };

// exports.tenantlogin = async (req, res, next) => {
//   try {

//     const result = await authService.login(req.body);

//     res.status(200).json({
//       status: "success",
//       data: result
//     });

//   } catch (err) {
//     next(err);
//   }
// };
  exports.login = async (req, res, next) => {
  try {
    const result = await authService.login(req.body);
    
    // ✅ MANUAL AUDIT LOG - LOGIN
    // Since req.user doesn't exist during login, we log manually here
    const AuditLog = require('../../models/auditLog.model');
    try {
      await AuditLog.create({
        action: 'LOGIN',
        module: 'auth',
        actor: {
          userId: result.user?._id || result._id,
          name: result.user?.name,
          role: result.user?.role?.slug || result.user?.role || 'unknown',
          email: result.user?.email || req.body.email
        },
        target: {
          type: 'User',
          id: result.user?._id || result._id,
          name: result.user?.name,
          email: result.user?.email || req.body.email,
          employeeId: result.user?.employeeId
        },
        metadata: {
          loginMethod: 'email',
          ip: req.ip || req.connection.remoteAddress,
          userAgent: req.get('user-agent'),
          mfaUsed: result.mfaRequired || false
        },
        org_id: result.user?.org_id || result.user?.orgId,
        company_id: result.user?.company_id || result.user?.companyId,
        unit_id: result.user?.unit_id || result.user?.unitId
      });
      console.log('[AuthAudit] LOGIN logged for:', result.user?.email || req.body.email);
    } catch (auditError) {
      console.error('[AuthAudit] Failed to log LOGIN:', auditError.message);
    }
    
    // ✅ Return a separate response when MFA is required
    if (result.mfaRequired) {
      return res.status(200).json({
        success:     true,
        mfaRequired: true,
        mfaToken:    result.mfaToken,
      });
    }
    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: result
    });
  } catch (error) {
    // ✅ LOG FAILED LOGIN ATTEMPT
    if (error.message?.includes('Invalid credentials') || error.message?.includes('password')) {
      const AuditLog = require('../../models/auditLog.model');
      try {
        await AuditLog.create({
          action: 'LOGIN_FAILED',
          module: 'auth',
          actor: {
            userId: null,
            name: null,
            role: null,
            email: req.body.email
          },
          target: {
            type: 'User',
            email: req.body.email
          },
          metadata: {
            reason: error.message,
            ip: req.ip || req.connection.remoteAddress,
            userAgent: req.get('user-agent')
          },
          org_id: null,
          company_id: null,
          unit_id: null
        });
        console.log('[AuthAudit] LOGIN_FAILED logged for:', req.body.email);
      } catch (auditErr) {
        console.error('[AuthAudit] Failed to log LOGIN_FAILED:', auditErr.message);
      }
    }
    next(error);
  }
};

exports.googleCallback = async (req, res, next) => {
  const { resolveCallbackUrl, buildRedirect } = require("./google.redirect");
  const callbackUrl = req.googleCallbackUrl || resolveCallbackUrl(req.query.state);
  const fail = message => res.redirect(buildRedirect(callbackUrl, { error: message }));

  try {
    const googleUser = req.user;

    if (googleUser.isNewUser) {
      return res.redirect(buildRedirect(callbackUrl, {
        newUser: "true",
        email: googleUser.email,
        name: googleUser.name || ""
      }));
    }

    const user = await User.findOne({ _id: googleUser.userId, is_deleted: false }).populate("roleId");
    if (!user) return fail("Account not found");
    if (user.status !== "ACTIVE") return fail("Your account is not active. Please contact your admin.");

    const Employee = require("../employee/models/employee.model");
    const terminatedEmployee = await Employee.findOne({ userId: user._id, status: "TERMINATED" }).select("_id").lean();
    if (terminatedEmployee) return fail("Your account is not active. Please contact your admin.");
    if (!user.roleId) return fail("No role is assigned to your account. Please contact your admin.");

    if (user.mfaEnabled) {
      const mfaToken = jwt.sign({ userId: user._id, mfaPending: true }, process.env.JWT_SECRET, { expiresIn: "5m" });
      return res.redirect(buildRedirect(callbackUrl, { mfaRequired: "true", mfaToken, email: user.email }));
    }

    const token = jwt.sign(
      {
        userId:     user._id,
        org_id:     user.org_id     || null,
        company_id: user.company_id || null,
        unit_id:    user.unit_id    || null,
        roleId:     user.roleId._id,
        role:       user.roleId.slug,
        level:      user.roleId.level,
        is_first_login: user.is_first_login || false,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    const AuditLog = require('../../models/auditLog.model');
    try {
      await AuditLog.create({
        action: 'GOOGLE_LOGIN',
        module: 'auth',
        userId: user._id,
        target: {
          type: 'User',
          id: user._id,
          email: user.email,
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim()
        },
        metadata: {
          loginMethod: 'google',
          googleId: googleUser.googleId,
          ip: req.ip || req.connection.remoteAddress,
          userAgent: req.get('user-agent')
        },
        org_id: user.org_id,
        company_id: user.company_id,
        unit_id: user.unit_id
      });
      console.log('[AuthAudit] GOOGLE_LOGIN logged for:', user.email);
    } catch (auditError) {
      console.error('[AuthAudit] Failed to log GOOGLE_LOGIN:', auditError.message);
    }

    const params = {
      token,
      isOnboardingComplete: !!(user.org_id || user.company_id || user.unit_id),
      isFirstLogin: !!user.is_first_login
    };

    return res.redirect(buildRedirect(callbackUrl, params));

  } catch (error) {
    console.error("[Google OAuth] googleCallback failed:", error);
    return fail("Google sign-in failed. Please try again.");
  }
};

exports.getMe = async (req, res, next) => {
  try {
    const result = await authService.getMe(req.user);
    return res.status(200).json({
      success: true,
      message: "User fetched successfully",
      data:    result
    });
  } catch (error) {
    next(error);
  }
};






// exports.googleCallback = async (req, res, next) => {
//   try {
//     const googleUser = req.user;
//     // console.log("Google user data:", googleUser);

//     // New user — company details are required
//     if (googleUser.isNewUser) {
//       const tempToken = jwt.sign(
//         {
//           email:     googleUser.email,
//           name:      googleUser.firstName,
//           googleId:  googleUser.googleId,
//           isNewUser: true
//         },
//         process.env.JWT_SECRET,
//         { expiresIn: "1h" }
//       );

//       // Redirect to the frontend onboarding page
//       return res.redirect(
//         `${process.env.FRONTEND_URL}/onboarding?token=${tempToken}`
//       );
//     }

//     // Existing user — normal login
//     const user = await User.findById(googleUser._id).populate("roleId");
//     const tenant = await Tenant.findOne({ _id: user.tenantId, isDeleted: false });

//     const token = jwt.sign(
//       {
//         userId:   user._id,
//         tenantId: user.tenantId,
//         roleId:   user.roleId._id,
//         role:     user.roleId.slug
//       },
//       process.env.JWT_SECRET,
//       { expiresIn: "1d" }
//     );
//     // Redirect to the frontend dashboard
//     return res.redirect(
//       `${process.env.GOOGLE_FRONTEND_REDIRECT_URI}/auth/google/callback?token=${token}`
//     );

//   } catch (error) {
//     next(error);
//   }
// };

// exports.googleCallback = async (req, res, next) => {
//   try {
//     const googleUser = req.user;

//     // New user — company details are required
//     if (googleUser.isNewUser) {
//       const tempToken = jwt.sign(
//         {
//           email:     googleUser.email,
//           name:      googleUser.firstName,
//           googleId:  googleUser.googleId,
//           isNewUser: true
//         },
//         process.env.JWT_SECRET,
//         { expiresIn: "1h" }
//       );

//       // ✅ No frontend available — return JSON
//       return res.status(200).json({
//         success:  true,
//         message:  "New user — complete registration",
//         isNewUser: true,
//         tempToken  // Send to the frontend later
//       });
//     }

//     // Existing user — normal login
//     const user = await User.findById(googleUser._id).populate("roleId");
//     const tenant = await Tenant.findOne({ _id: user.tenantId, isDeleted: false });

//     const token = jwt.sign(
//       {
//         userId:   user._id,
//         tenantId: user.tenantId,
//         roleId:   user.roleId._id,
//         role:     user.roleId.slug
//       },
//       process.env.JWT_SECRET,
//       { expiresIn: "1d" }
//     );

//     // ✅ No frontend available — return JSON
//     return res.status(200).json({
//       success: true,
//       message: "Login successful",
//       data: {
//         token,
//         user: {
//           id:       user._id,
//           name:     user.name,
//           email:    user.email,
//           tenantId: user.tenantId,
//           role: {
//             name: user.roleId.name,
//             slug: user.roleId.slug
//           }
//         },
//         onboarding: {
//           isComplete:  tenant?.isOnboardingComplete || false,
//           currentStep: tenant?.onboardingStep || 1,
//           totalSteps:  3
//         },
//         trial: {
//           plan:        tenant?.plan,
//           trialEndsAt: tenant?.trialEndsAt,
//           daysLeft:    tenant ? Math.ceil((new Date(tenant.trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)) : null
//         }
//       }
//     });

//   } catch (error) {
//     next(error);
//   }
// };

exports.completeRegistration = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) throw new AppError("Token required", 401);

    // Verify the temporary token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      throw new AppError("Invalid or expired token", 401);
    }

    // Check isNewUser to prevent access with a regular token
    if (!decoded.isNewUser) {
      throw new AppError("Invalid token", 401);
    }

    const result = await authService.completeRegistration(req.body, decoded);

    return res.status(201).json({
      success: true,
      message: "Registration complete! Trial started.",
      data:    result
    });

  } catch (error) {
    next(error);
  }
};

exports.updateMe = async (req, res, next) => {
  try {
    const allowed = ["name", "email", "phone"]; // whitelist only
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const user = await authService.updateProfile(req.user.userId, updates);
    res.json({ success: true, message: "Profile updated", data: user });
  } catch (err) { next(err); }
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const result = await authService.forgotPassword(req.body.email);
    return res.status(200).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    next(error);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;
    const result = await authService.resetPassword(token, password);
    return res.status(200).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    next(error);
  }
};