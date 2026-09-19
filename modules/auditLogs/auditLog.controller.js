"use strict";
const service = require("./auditLog.service");
const AppError = require("../../utils/appError");

// ── STRICT ROLE CHECK: Only Admins Can Access ──────────────────────────────
// Note: SUPER_ADMIN JWT uses uppercase, but role.slug in DB is lowercase "super_admin"
const ADMIN_ROLES = ["SUPER_ADMIN", "super_admin", "org_admin", "company_admin", "unit_admin"];

exports.getLogs = async (req, res, next) => {
  try {
    // Enforce strict admin-only access
    if (!ADMIN_ROLES.includes(req.user.role)) {
      throw new AppError("Access denied. Only administrators can view audit logs.", 403);
    }
    const data = await service.getLogs(req.query, req.user);
    res.status(200).json({ success: true, data });
  } catch (e) { next(e); }
};

exports.exportLogs = async (req, res, next) => {
  try {
    if (!ADMIN_ROLES.includes(req.user.role)) {
      throw new AppError("Access denied. Only administrators can view audit logs.", 403);
    }
    const firstPage = await service.getLogs({ ...req.query, page: 1, limit: 1 }, req.user);
    const { logs } = await service.getLogs({ ...req.query, page: 1, limit: firstPage.total || 1 }, req.user);
    // Quote every CSV field so commas and embedded quotes cannot shift columns.
    const escapeCsv = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = logs.map(log => [
      log.createdAt, log.action, log.module, log.user?.name, log.user?.email,
      log.target?.name, log.description
    ].map(escapeCsv).join(","));
    const csv = ["Timestamp,Action,Module,User,Email,Target,Description", ...rows].join("\r\n");
    res.status(200).json({ success: true, data: { csv } });
  } catch (e) { next(e); }
};

exports.getEmployeeTimeline = async (req, res, next) => {
  try {
    // Enforce strict admin-only access
    if (!ADMIN_ROLES.includes(req.user.role)) {
      throw new AppError("Access denied. Only administrators can view audit logs.", 403);
    }
    const data = await service.getEmployeeTimeline(req.params.employeeId, req.user);
    res.status(200).json({ success: true, data });
  } catch (e) { next(e); }
};

// ── HR-SPECIFIC AUDIT LOGS (Employee-level actions for HR) ─────────────────
// HR Manager/HR roles can view specific employee actions within their scope
const HR_ROLES = ["hr_manager", "company_hr_manager", "hr", "company_admin", "unit_admin"];

exports.getHREmployeeLogs = async (req, res, next) => {
  try {
    // Only HR roles and company admins can access this endpoint
    if (!HR_ROLES.includes(req.user.role)) {
      throw new AppError("Access denied. Only HR personnel can view employee audit logs.", 403);
    }
    
    const data = await service.getHREmployeeLogs(req.query, req.user);
    res.status(200).json({ success: true, data });
  } catch (e) { next(e); }
};