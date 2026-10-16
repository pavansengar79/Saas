// modules/payrollPolicy/models/payrollPeriodLock.model.js
//
// Payroll Period Lock — lock an entire month
// After locking:
//   - Payroll re-run blocked
//   - Payslip delete blocked  
//   - Employee salary edits blocked for the payroll month
//   - Changes are only possible after unlocking
"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

const payrollPeriodLockSchema = new Schema({

  // ─── Scope ───────────────────────────────────────────────────
  org_id:     { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  company_id: { type: Schema.Types.ObjectId, ref: "Company",      required: true, index: true },
  unit_id:    { type: Schema.Types.ObjectId, ref: "Unit",         default: null, index: true },

  // ─── Period ──────────────────────────────────────────────────
  month: { type: Number, required: true }, // 1-12
  year:  { type: Number, required: true }, // e.g. 2026
  period: { type: String, required: true }, // "Jun 2026"

  // ─── Lock Status ─────────────────────────────────────────────
  isLocked:   { type: Boolean, default: true, index: true },
  lockedAt:   { type: Date,    default: Date.now },
  lockedBy:   { type: Schema.Types.ObjectId, ref: "User" },
  lockReason: { type: String, trim: true, maxlength: 500 },

  // ─── Unlock ──────────────────────────────────────────────────
  unlockedAt:   { type: Date,    default: null },
  unlockedBy:   { type: Schema.Types.ObjectId, ref: "User", default: null },
  unlockReason: { type: String,  default: null },

  // ─── Stats at time of lock ───────────────────────────────────
  totalEmployees:  { type: Number, default: 0 },
  totalPayslips:   { type: Number, default: 0 },
  totalNetPayroll: { type: Number, default: 0 },

  // ─── History ─────────────────────────────────────────────────
  history: [{
    action:  { type: String, enum: ["LOCKED", "UNLOCKED"] },
    by:      { type: Schema.Types.ObjectId, ref: "User" },
    at:      { type: Date },
    reason:  { type: String },
    _id:     false,
  }],

  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User" },

}, {
  timestamps: true,
  toJSON:   { virtuals: true },
  toObject: { virtuals: true },
});

// One lock record per unit per month/year
payrollPeriodLockSchema.index(
  { org_id: 1, company_id: 1, unit_id: 1, month: 1, year: 1 },
  { unique: true }
);

module.exports = mongoose.models.PayrollPeriodLock ||
  mongoose.model("PayrollPeriodLock", payrollPeriodLockSchema);