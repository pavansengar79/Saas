// modules/payrollPolicy/payrollLock.service.js
"use strict";

const PayrollPeriodLock = require("./models/payrollPeriodLock.model");
const Payslip           = require("./models/payslip.model");
const AppError          = require("../../utils/appError");
const mongoose          = require("mongoose");

const toObjId = (id) => new mongoose.Types.ObjectId(String(id));

const buildLockScope = (org_id, company_id, unit_id) => {
  const scope = {
    org_id: toObjId(org_id),
    company_id: toObjId(company_id),
    unit_id: unit_id ? toObjId(unit_id) : null,
  };
  return scope;
};

// ─── Helper: parse month string ──────────────────────────────
// "2026-06" → { month: 6, year: 2026, period: "Jun 2026" }
const parseMonth = (monthStr) => {
  if (!monthStr) throw new AppError("month is required (e.g. 2026-06)", 400);
  const [year, month] = monthStr.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new AppError("Invalid month format. Use YYYY-MM (e.g. 2026-06)", 400);
  }
  const months = ["Jan","Feb","Mar","Apr","May","Jun",
                  "Jul","Aug","Sep","Oct","Nov","Dec"];
  return { month, year, period: `${months[month - 1]} ${year}` };
};

// ─── CHECK if period is locked ────────────────────────────────
exports.isPeriodLocked = async (month, year, org_id, unit_id, company_id) => {
  const scope = buildLockScope(org_id, company_id, unit_id);
  if (unit_id) scope.unit_id = { $in: [toObjId(unit_id), null] };

  const lock = await PayrollPeriodLock.findOne({
    ...scope,
    month,
    year,
    isLocked: true,
  }).lean();
  return !!lock;
};

// ─── LOCK period ─────────────────────────────────────────────
exports.lockPeriod = async (payload, user) => {
  const { month: monthStr, reason } = payload;
  const { month, year, period } = parseMonth(monthStr);

  // Check already locked
  const existing = await PayrollPeriodLock.findOne({
    ...buildLockScope(user.orgId, user.companyId, user.unitId),
    month,
    year,
  });

  if (existing?.isLocked) {
    throw new AppError(`Payroll for ${period} is already locked`, 409);
  }

  // Get payslip stats
  const payslips = await Payslip.find({
    ...buildLockScope(user.orgId, user.companyId, user.unitId),
    month,
    year,
    isDeleted: false,
  }).lean();

  const totalNetPayroll = payslips.reduce((sum, p) => sum + (p.netSalary || 0), 0);

  if (existing) {
    // Re-lock after unlock
    existing.isLocked     = true;
    existing.lockedAt     = new Date();
    existing.lockedBy     = toObjId(user.userId);
    existing.lockReason   = reason || null;
    existing.unlockedAt   = null;
    existing.unlockedBy   = null;
    existing.unlockReason = null;
    existing.updatedBy    = toObjId(user.userId);
    existing.history.push({ action: "LOCKED", by: toObjId(user.userId), at: new Date(), reason: reason || null });
    await existing.save();
    return existing;
  }

  // Create new lock
  const lock = await PayrollPeriodLock.create({
    org_id:          toObjId(user.orgId),
    company_id:      toObjId(user.companyId),
    unit_id:         user.unitId ? toObjId(user.unitId) : null,
    month,
    year,
    period,
    isLocked:        true,
    lockedAt:        new Date(),
    lockedBy:        toObjId(user.userId),
    lockReason:      reason || null,
    totalEmployees:  [...new Set(payslips.map(p => p.employee_id?.toString()))].length,
    totalPayslips:   payslips.length,
    totalNetPayroll,
    history: [{ action: "LOCKED", by: toObjId(user.userId), at: new Date(), reason: reason || null }],
    createdBy:       toObjId(user.userId),
  });

  return lock;
};

// ─── UNLOCK period ────────────────────────────────────────────
exports.unlockPeriod = async (payload, user) => {
  const { month: monthStr, reason } = payload;
  if (!reason) throw new AppError("reason is required to unlock payroll period", 400);

  const { month, year, period } = parseMonth(monthStr);

  const lock = await PayrollPeriodLock.findOne({
    ...buildLockScope(user.orgId, user.companyId, user.unitId),
    month,
    year,
  });

  if (!lock) throw new AppError(`No lock record found for ${period}`, 404);
  if (!lock.isLocked) throw new AppError(`Payroll for ${period} is not locked`, 400);

  lock.isLocked     = false;
  lock.unlockedAt   = new Date();
  lock.unlockedBy   = toObjId(user.userId);
  lock.unlockReason = reason;
  lock.updatedBy    = toObjId(user.userId);
  lock.history.push({ action: "UNLOCKED", by: toObjId(user.userId), at: new Date(), reason });
  await lock.save();

  return lock;
};

// ─── GET LOCK STATUS ─────────────────────────────────────────
exports.getLockStatus = async (monthStr, user) => {
  const { month, year, period } = parseMonth(monthStr);

  const lock = await PayrollPeriodLock.findOne({
    ...buildLockScope(user.orgId, user.companyId, user.unitId),
    month,
    year,
  })
    .populate("lockedBy",   "name email")
    .populate("unlockedBy", "name email")
    .populate("history.by", "name email")
    .lean();

  if (user.unitId && !lock?.isLocked) {
    const companyLock = await PayrollPeriodLock.findOne({
      ...buildLockScope(user.orgId, user.companyId, null),
      month,
      year,
      isLocked: true,
    })
      .populate("lockedBy", "name email")
      .populate("unlockedBy", "name email")
      .populate("history.by", "name email")
      .lean();
    if (companyLock) return companyLock;
  }

  if (!lock) {
    return { period, isLocked: false, message: `Payroll for ${period} is not locked` };
  }

  return lock;
};

// ─── GET ALL LOCK RECORDS ────────────────────────────────────
exports.getAllLocks = async (query, user) => {
  const { year, page = 1, limit = 12 } = query;

  const filter = {
    ...buildLockScope(user.orgId, user.companyId, user.unitId),
  };
  if (year) filter.year = Number(year);

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await PayrollPeriodLock.countDocuments(filter);
  const locks = await PayrollPeriodLock.find(filter)
    .sort({ year: -1, month: -1 })
    .skip(skip)
    .limit(Number(limit))
    .populate("lockedBy",   "name email")
    .populate("unlockedBy", "name email")
    .lean();

  return { locks, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) };
};