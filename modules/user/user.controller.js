// modules/user/user.controller.js
// Task 3.5 — User Invite + CRUD + Role Assignment

const userService = require("./user.service");
const User = require("../auth/models/user.model");
const AppError = require("../../utils/appError");

// ── POST /users/invite ────────────────────────────────────────
exports.inviteUser = async (req, res, next) => {
  try {
    const result = await userService.inviteUser(req.body, req.user);

    res.status(201).json({
      success: true,
      message: "Invite sent successfully",
      data:    result,
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /users ────────────────────────────────────────────────
exports.getUsers = async (req, res, next) => {
  try {
    const result = await userService.getUsers(req.query, req.user);

    res.json({
      success: true,
      message: "Users fetched successfully",
      data:    result,
    });
  } catch (err) {
    next(err);
  }
};

// ── PUT /users/:id ────────────────────────────────────────────
exports.updateUser = async (req, res, next) => {
  try {
    const user = await userService.updateUser(req.params.id, req.body, req.user);

    res.json({
      success: true,
      message: "User updated successfully",
      data:    user,
    });
  } catch (err) {
    next(err);
  }
};

// ── DELETE /users/:id ─────────────────────────────────────────
exports.deleteUser = async (req, res, next) => {
  try {
    const result = await userService.deleteUser(req.params.id, req.user, req.body?.confirmCompanyAdminDeactivation);

    res.json({
      success: true,
      message: result.message,
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /users/:id/progression ────────────────────────────────
exports.getProgressionHistory = async (req, res, next) => {
  try {
    const result = await userService.getProgressionHistory(req.params.id, req.user);

    res.json({
      success: true,
      message: "Progression history fetched",
      data:    result,
    });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/v1/users/:id/photo (Upload Profile Photo) ─────────────
exports.uploadProfilePhoto = async (req, res, next) => {
  try {
    if (!req.file) {
      return next(new AppError("No file uploaded", 400));
    }

    // File uploaded to Cloudinary via multer middleware
    const photoUrl = req.file.path; // Cloudinary URL

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { profilePhoto: photoUrl },
      { new: true }
    ).select("profilePhoto name email roleId org_id company_id unit_id");

    if (!user) {
      return next(new AppError("User not found", 404));
    }

    // ── SYNC: Update Employee photo if user is unit-level ────────────
    // Unit-level users have an associated Employee record
    const Role = require("../role/role.model");
    const role = await Role.findById(user.roleId).select("slug level").lean();
    
    if (role?.level === 'unit' || role?.slug === 'employee') {
      const Employee = require("../employee/models/employee.model");
      await Employee.findOneAndUpdate(
        { userId: user._id },
        { profilePhoto: photoUrl },
        { new: true }
      ).select("profilePhoto");
      console.log(`✅ Synced profile photo to Employee record for user ${user.email}`);
    }

    res.json({
      success: true,
      message: "Profile photo uploaded successfully",
      data: { profilePhoto: user.profilePhoto },
    });
  } catch (err) {
    next(err);
  }
};