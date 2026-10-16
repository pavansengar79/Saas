// modules/attendance/models/attendanceRegularization.model.js
//
// Attendance Regularization Request
// Employee → missed punch / wrong time → request correction
// Manager (L1) → Approve/Reject
// HR (L2) → Approve/Reject
// System → Auto recalculate attendance record

"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

const actionSchema = new Schema({
  level:       { type: Number },                           // 1 = L1, 2 = L2
  actorId:     { type: Schema.Types.ObjectId, ref: "User" },
  actorName:   { type: String },
  actorRole:   { type: String },
  action:      { type: String, enum: ["APPROVED", "REJECTED", "CANCELLED"] },
  comment:     { type: String, trim: true, maxlength: 500 },
  actionAt:    { type: Date, default: Date.now },
}, { _id: false });

const regularizationSchema = new Schema({

  // ─── Scope ───────────────────────────────────────────────────
  org_id:     { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  company_id: { type: Schema.Types.ObjectId, ref: "Company",      required: true, index: true },
  unit_id:    { type: Schema.Types.ObjectId, ref: "Unit",         required: true, index: true },

  // ─── Employee ────────────────────────────────────────────────
  employeeId: { type: Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
  userId:     { type: Schema.Types.ObjectId, ref: "User",     required: true },
  leaveTypeId: { type: Schema.Types.ObjectId, ref: "LeaveType", default: null },
isLWP:       { type: Boolean, default: false },

  // ─── Attendance Record Reference ─────────────────────────────
  attendanceId: { type: Schema.Types.ObjectId, ref: "Attendance", default: null },
  date:         { type: Date, required: true, index: true },
  
  // ─── Policy Reference ────────────────────────────────────────
  policyId:     { type: Schema.Types.ObjectId, ref: "RegularisationPolicy", default: null },

  // ─── Requested Changes ───────────────────────────────────────
  requestedCheckIn:  { type: Date, default: null },   // requested punch-in time
  requestedCheckOut: { type: Date, default: null },   // requested punch-out time
  requestedStatus:   {
    type: String,
    enum: ["PRESENT", "HALF_DAY", "WFH", "ON_LEAVE"],
    default: "PRESENT"
  },

  // ─── Reason & Proof ──────────────────────────────────────────
  reason:      { type: String, required: true, trim: true, maxlength: 1000 },
  attachments: [{ type: String }],   // URLs (Cloudinary)

  // ─── Regularization Type ─────────────────────────────────────
  regularizationType: {
    type: String,
    enum: [
      "MISSED_PUNCH_IN",
      "MISSED_PUNCH_OUT",
      "BOTH_MISSED",
      "WRONG_TIME",
      "WFH_CORRECTION",
      "STATUS_CORRECTION",
    ],
    required: true,
  },

  // ─── Approval Flow ───────────────────────────────────────────
  // L1 = Reporting Manager, L2 = HR Manager
  l1ApproverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  l1Status:     { type: String, enum: ["APPROVED", "REJECTED", null], default: null },
  l1ActionAt:   { type: Date, default: null },
  l1Comment:    { type: String, default: null },

  l2ApproverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  l2Status:     { type: String, enum: ["APPROVED", "REJECTED", null], default: null },
  l2ActionAt:   { type: Date, default: null },
  l2Comment:    { type: String, default: null },

  // ─── Overall Status ──────────────────────────────────────────
  status: {
    type: String,
    enum: ["PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "CANCELLED", "APPLIED"],
    default: "PENDING",
    index: true,
  },
  raisedOnBehalf: { type: Boolean, default: false },
  raisedBy:       { type: Schema.Types.ObjectId, ref: "User", default: null },
  // ─── Flexible Approval Flow ──────────────────────────────────
approvalFlow: {
  type:    String,
  enum:    ["L1_ONLY", "L2_ONLY", "L1_L2", "AUTO"],
  default: "L2_ONLY",
},

// AT-14 fields (if not already added)
raisedOnBehalf: { type: Boolean, default: false },
raisedBy:       { type: Schema.Types.ObjectId, ref: "User", default: null },

  // ─── Post-Approval ───────────────────────────────────────────
  isApplied:   { type: Boolean, default: false },  // true when attendance updated
  appliedAt:   { type: Date, default: null },
  appliedBy:   { type: Schema.Types.ObjectId, ref: "User", default: null },

  // ─── Approval History ────────────────────────────────────────
  approvalHistory: [actionSchema],

  // ─── Soft Delete ─────────────────────────────────────────────
  isDeleted:  { type: Boolean, default: false },
  createdBy:  { type: Schema.Types.ObjectId, ref: "User" },
  updatedBy:  { type: Schema.Types.ObjectId, ref: "User" },

}, {
  timestamps: true,
  toJSON:   { virtuals: true },
  toObject: { virtuals: true },
});

// Indexes
regularizationSchema.index({ org_id: 1, employeeId: 1, date: 1 });
regularizationSchema.index({ org_id: 1, status: 1 });
regularizationSchema.index({ l1ApproverId: 1, status: 1 });
regularizationSchema.index({ l2ApproverId: 1, status: 1 });


module.exports = mongoose.model("AttendanceRegularization", regularizationSchema);