// modules/leave/models/leaveRequest.models.js
// UPDATED — tenantId → org_id + company_id + unit_id

const mongoose = require("mongoose");

// ─── Approval Action Sub-Schema ───────────────────────────
const approvalActionSchema = new mongoose.Schema(
  {
    level: {
      type:     Number,
      enum:     [1, 2],
      required: true,
    },

    approverId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
    },

    approverName: { type: String, required: true },
    approverRole: { type: String, required: true },

    action: {
      type:     String,
      enum:     ["APPROVED", "REJECTED", "FORWARDED"],
      required: true,
    },

    comment:  { type: String, trim: true, maxlength: 500 },
    actionAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// ─── Leave Request Schema ─────────────────────────────────
const leaveRequestSchema = new mongoose.Schema(
  {
    // ── Scope Fields ──────────────────────────────────────
    org_id: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Organization",
      required: true,
      index:    true,
    },

    company_id: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
      index:    true,
    },

    unit_id: {
      type:  mongoose.Schema.Types.ObjectId,
      ref:   "Unit",
      index: true,
    },

    // ── Core Fields ───────────────────────────────────────
    employeeId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Employee",
      required: true,
    },

    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
    },

    leaveTypeId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "LeaveType",
      required: true,
    },

    // ── Date Range ────────────────────────────────────────
    startDate: { type: Date, required: [true, "Start date is required"] },
    endDate:   { type: Date, required: [true, "End date is required"] },

    // ── Half Day ──────────────────────────────────────────
    isHalfDay: { type: Boolean, default: false },
    session: {
      type:    String,
      enum:    ["FIRST_HALF", "SECOND_HALF", null],
      default: null,
    },

    totalDays: {
      type:     Number,
      required: true,
      min:      [0.5, "Leave must be at least half a day"],
    },

    // ── Reason & Docs ─────────────────────────────────────
    reason: {
      type:      String,
      required:  [true, "Reason for leave is required"],
      trim:      true,
      minlength: [10, "Reason must be at least 10 characters"],
      maxlength: [1000, "Reason cannot exceed 1000 characters"],
    },

    attachments: [{
      name:       String,
      url:        String,
      fileType:   String,
      uploadedAt: { type: Date, default: Date.now },
    }],

    // ── Approval Workflow ─────────────────────────────────
    status: {
      type:    String,
      enum:    ["DRAFT", "PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "CANCELLED"],
      default: "PENDING",
      index:   true,
    },
    editedAt: { type: Date, default: null },
    editedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    l1ApproverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    l1Status:     { type: String, enum: ["PENDING", "APPROVED", "REJECTED", null], default: null },
    l1ActionAt:   { type: Date, default: null },
    l1Comment:    { type: String, trim: true, maxlength: 500, default: null },

    l2ApproverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    l2Status:     { type: String, enum: ["PENDING", "APPROVED", "REJECTED", null], default: null },
    l2ActionAt:   { type: Date, default: null },
    l2Comment:    { type: String, trim: true, maxlength: 500, default: null },

    approvalHistory: { type: [approvalActionSchema], default: [] },

    coveringEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },

    // ── Cancellation ──────────────────────────────────────
    cancelledAt:        { type: Date, default: null },
    cancelledBy:        { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    cancellationReason: { type: String, trim: true, maxlength: 500, default: null },

    // ── Balance Tracking ──────────────────────────────────
    isBalanceDeducted: { type: Boolean, default: false },
    balanceAtRequest: {
      totalAllocated: Number,
      used:           Number,
      remaining:      Number,
    },

    isDeleted: { type: Boolean, default: false, select: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ──────────────────────────────────────────────
leaveRequestSchema.index({ org_id: 1, company_id: 1, employeeId: 1, status: 1 });
leaveRequestSchema.index({ company_id: 1, startDate: 1, endDate: 1 });
leaveRequestSchema.index({ unit_id: 1, l1ApproverId: 1, status: 1 }); // Manager inbox
leaveRequestSchema.index({ company_id: 1, l2ApproverId: 1, status: 1 }); // HR inbox
leaveRequestSchema.index({ company_id: 1, isDeleted: 1, createdAt: -1 });

// ─── Virtuals ─────────────────────────────────────────────
leaveRequestSchema.virtual("duration").get(function () {
  if (this.isHalfDay) {
    return `0.5 day (${this.session === "FIRST_HALF" ? "First half" : "Second half"})`;
  }
  return `${this.totalDays} day(s)`;
});

leaveRequestSchema.virtual("isActionable").get(function () {
  return ["PENDING", "UNDER_REVIEW"].includes(this.status);
});

// ─── Pre-validation Hook ───────────────────────────────────
// Mongoose 9 passes no `next` to pre hooks — throw to fail validation
leaveRequestSchema.pre("validate", function () {
  if (this.isHalfDay) {
    if (!this.session) {
      throw new Error("Session (FIRST_HALF/SECOND_HALF) is required for half day leave");
    }
    const start = new Date(this.startDate);
    const end   = new Date(this.endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    if (start.getTime() !== end.getTime()) {
      throw new Error("Start date and end date must be same for half day leave");
    }
    this.totalDays = 0.5;
  }
  if (this.endDate < this.startDate) {
    throw new Error("End date cannot be before start date");
  }
  // next();
});

// ─── Query Middleware ──────────────────────────────────────
leaveRequestSchema.pre(/^find/, function (next) {
  if (!this.getOptions().includeDeleted) {
    this.where({ isDeleted: false });
  }
});

// ─── Instance Methods ──────────────────────────────────────
leaveRequestSchema.methods.canUserAct = function (user) {
  const userId = user._id.toString();

  // Admin bypass
  if (user.role === "SUPER_ADMIN") return { canAct: true, level: null, reason: "Super Admin override" };
  if (user.role === "org_admin") return { canAct: true, level: null, reason: "Org Admin override" };
  if (user.role === "company_admin") return { canAct: true, level: null, reason: "Company Admin override" };

  if (!["PENDING", "UNDER_REVIEW"].includes(this.status)) {
    return { canAct: false, level: null, reason: `Request is already ${this.status}` };
  }

  // Normalize IDs
  const normalizeId = (id) => id ? String(id) : null;
  const currentUserId = normalizeId(user._id);
  const requestL1Approver = normalizeId(this.l1ApproverId);
  const requestL2Approver = normalizeId(this.l2ApproverId);

  // L1 — Manager
  if (this.status === "PENDING" && requestL1Approver === currentUserId) {
    return { canAct: true, level: 1, reason: "L1 Approver (Manager)" };
  }

  // L2 — HR Manager
  if (this.status === "UNDER_REVIEW" && requestL2Approver === currentUserId) {
    return { canAct: true, level: 2, reason: "L2 Approver (HR Manager)" };
  }

  // HR Manager — flexible role checking
  const hrManagerRoles = ["hr_manager", "company_hr_manager", "unit_admin", "hr", "HR", "hr-admin"];
  if (hrManagerRoles.includes(user.role)) {
    if (this.status === "PENDING") {
      return { canAct: true, level: 1, reason: "HR Manager can approve L1" };
    }
    if (this.status === "UNDER_REVIEW") {
      return { canAct: true, level: 2, reason: "HR Manager can approve L2" };
    }
  }

  // No approvers assigned — allow HR to approve
  if (!requestL1Approver && !requestL2Approver && hrManagerRoles.includes(user.role)) {
    return { canAct: true, level: this.status === "PENDING" ? 1 : 2, reason: "HR Manager (no approvers assigned)" };
  }

  return { canAct: false, level: null, reason: "You are not authorized to act on this request" };
};

leaveRequestSchema.methods.canEmployeeCancel = function (userId) {
  if (!["PENDING", "UNDER_REVIEW"].includes(this.status)) {
    return { canCancel: false, reason: `Cannot cancel — request is ${this.status}` };
  }
  if (this.userId.toString() !== userId.toString()) {
    return { canCancel: false, reason: "You can only cancel your own leave" };
  }
  return { canCancel: true };
};

module.exports = mongoose.model("LeaveRequest", leaveRequestSchema);