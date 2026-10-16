// src/modules/superAdmin/models/auditLog.model.js
const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    // Who performed the action
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null, // Super Admin has no database record
    },

    actorEmail: {
      type: String,
      required: true, // snapshot — keep the log even if the user is deleted
    },

    // What action was performed
    action: {
      type: String,
      required: true,
      enum: ["PLAN_OVERRIDE", "TENANT_SUSPEND", "TENANT_ACTIVATE", "TENANT_STATUS_CHANGE", "LOGIN", "STATUS_CHANGE"],
      index: true,
    },

    // Module where action occurred
    module: {
      type: String,
      required: true,
      default: "superAdmin",
      enum: ["superAdmin", "auth"],
    },

    // Which tenant was affected
    targetTenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      default: null,
    },

    // Extra info — from/to plan, reason etc.
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Log the IP address
    ipAddress: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Indexes — for frequent queries
auditLogSchema.index({ actorEmail: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ targetTenantId: 1 });
auditLogSchema.index({ createdAt: -1 });

// Audit logs are permanent — no soft delete or pre hook

module.exports = mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);