// modules/role/role.model.js
//
// MODIFIED:
//   - Removed tenantId
//   + Added org_id, company_id, unit_id
//   + Added level (org/company/unit) — KEY FIELD for vertical hierarchy
//   - Fixed unique index: slug + org_id + level

const mongoose = require("mongoose");
const { Schema } = mongoose;

const roleSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    // null = system role (available to all orgs)
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      default: null,
      index: true,
    },

    // null for org level roles
    company_id: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      default: null,
    },

    // null for org and company level roles
    unit_id: {
      type: Schema.Types.ObjectId,
      ref: "Unit",
      default: null,
    },

    // KEY FIELD — vertical scope of this role
    // org     → Org Admin level
    // company → Company Admin level
    // unit    → Unit level (HR, Manager, Employee)
    level: {
      type: String,
      enum: ["org", "company", "unit"],
      required: true,
    },

    description: {
      type: String,
      default: "",
    },

    permissions: [
      {
        type: Schema.Types.ObjectId,
        ref: "Permission",
      },
    ],

    // T-01 — User class (Pavan's decision)
    // Administrative → can configure system (Org Admin, Company Admin, HR Manager, Unit Admin)
    // Privilege       → functional access on top of General User base (Finance Mgr, Sales Head)
    // General         → baseline self-service (Employee — auto-assigned)
    userClass: {
      type:    String,
      enum:    ["Administrative", "Privilege", "General"],
      default: "Privilege",
    },

    // T-03 — Module Access Matrix
    // Which modules this role can access
    // e.g. ["hrms", "crm", "sales", "bd", "admin"]
    modules: {
      type:    [String],
      default: [],
    },

    // true = cannot be edited or deleted by any customer admin
    isSystem: {
      type: Boolean,
      default: false,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// Unique per org + level
roleSchema.index({ slug: 1, org_id: 1, level: 1 }, { unique: true });

module.exports = mongoose.model("Role", roleSchema);