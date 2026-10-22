// modules/auth/models/user.model.js
//
// Task 6 — MODIFIED (final version)
//
// Changes from original:
//   1. tenantId removed → replaced with org_id (ref Organization)
//   2. company_id added (ObjectId ref Company, default null)
//   3. unit_id added   (ObjectId ref Unit, default null)
//   4. is_first_login  added (Boolean, default false)
//   5. Unique index fixed: email + org_id (was email + tenantId)
//
// All other fields kept exactly as they were.
//
// ─── Scope by role level ──────────────────────────────────────
//   Org Admin     → org_id set | company_id: null | unit_id: null
//   Company Admin → org_id set | company_id set   | unit_id: null
//   Unit Admin    → org_id set | company_id set   | unit_id set
//   HR / Manager  → org_id set | company_id set   | unit_id set
//   Employee      → org_id set | company_id set   | unit_id set
//
// ─── roleId — single role (future: roleIds[]) ─────────────────
//   Currently one user holds exactly one role.
//   FUTURE: when multi-role support is needed (e.g. same person
//   is Company Admin of Tata Steel AND Manager of a unit),
//   change roleId → roleIds: [{ type: ObjectId, ref: "Role" }]
//   and update JWT payload + permission middleware accordingly.
//   Do NOT implement now — design is forward-compatible.

const mongoose = require("mongoose");
const { Schema } = mongoose;

const userSchema = new mongoose.Schema(
  {
    // ─── Scope Fields (replaces tenantId) ────────────────────
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
      default: null,
      // null only for Product Admin / Super Admin (no org)
    },

    company_id: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      // null for Org Admin (org-level, not inside a company yet)
    },

    unit_id: {
      type: Schema.Types.ObjectId,
      ref: "Unit",
      default: null,
      // null for Org Admin and Company Admin
    },

    // ─── Identity ─────────────────────────────────────────────
    name: {
      type: String,
      trim: true,
    },

    lastName: {
      type: String,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    phone: {
      type: String,
      trim: true,
    },

    // ─── Profile Photo for Admin Users ────────────────────────
    profilePhoto: {
      type: String,
      default: null,
    },

    // ─── Auth ─────────────────────────────────────────────────
    password: {
      type: String,
      required: false,
      select: false,
    },

    // true  = user received temp password, must change on first login
    // false = user has set their own password (normal state)
    // Reset to false after POST /auth/set-password completes (Task 17)
    is_first_login: {
      type: Boolean,
      default: false,
    },

    // Single role for now — FUTURE: roleIds: [{ type: ObjectId, ref: "Role" }]
    roleId: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },

    // ─── Status ───────────────────────────────────────────────
    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE", "BLOCKED"],
      default: "INACTIVE",
    },

    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    googleId: {
      type: String,
      default: undefined,
      index: { unique: true, sparse: true },
    },

    // ─── Push Notifications (FCM) ────────────────────────────
    fcmTokens: [{
      token: {
        type: String,
        required: true
      },
      deviceType: {
        type: String,
        enum: ["web", "android", "ios"],
        default: "web"
      },
      deviceId: {
        type: String,
        default: null
      },
      lastUsed: {
        type: Date,
        default: Date.now
      },
      createdAt: {
        type: Date,
        default: Date.now
      }
    }],

    notificationEmailEnabled: {
      type: Boolean,
      default: true,
    },

    // ─── Security ─────────────────────────────────────────────
    loginAttempts: {
      type: Number,
      default: 0,
    },

    lockUntil: Date,
    lastLogin:  Date,

    refreshTokens: [String],

    // ─── SSO (Single Sign-On) ─────────────────────────────────
    ssoProfileId: {
      type: String,
      default: null,
    },

    ssoConnectionId: {
      type: String,
      default: null,
    },

    ssoProvider: {
      type: String,
      default: null, // e.g., "Okta", "Azure AD", "Google Workspace"
    },

    // ─── MFA ──────────────────────────────────────────────────
    mfaSecret: {
      type: String,
      select: false,
      default: null,
    },

    mfaEnabled: {
      type: Boolean,
      default: false,
    },

    mfaEnrolledAt: {
      type: Date,
      default: null,
    },

    mfaTempSecret: {
      type: String,
      select: false,
      default: null,
    },

    mfaBackupCodes: {
      type: [{
        codeHash: String,
        used: { type: Boolean, default: false },
        usedAt: Date
      }],
      select: false,
      default: [],
    },

    // T-26 — Block timestamp for JWT invalidation
    // When set: any JWT issued before this timestamp is invalid
    blockedAt: {
      type:    Date,
      default: null,
    },

    // ─── Meta ─────────────────────────────────────────────────
    is_deleted: {
      type: Boolean,
      default: false,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────
// Unique email per org
// org_id: null handles Super Admin (one globally unique email)
userSchema.index({ email: 1, org_id: 1 }, { unique: true });

module.exports = mongoose.model("User", userSchema);