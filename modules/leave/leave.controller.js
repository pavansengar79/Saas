// modules/leave/leave.controller.js

const leaveService        = require("./leave.service");
const leaveRequestService = require("./leaveRequest.service");

// ─── LEAVE TYPES ──────────────────────────────────────────────────────────────
// (used by leave.type.route.js — NOT by leave.route.js)

exports.create = async (req, res, next) => {
  try {
    const result = await leaveService.create(req.body, req.user, req.query);
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.getAll = async (req, res, next) => {
  try {
    const result = await leaveService.getAll(req.query, req.user);
    res.status(200).json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.getOne = async (req, res, next) => {
  try {
    const result = await leaveService.getOne(req.params.id, req.user, req.query);
    res.status(200).json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.update = async (req, res, next) => {
  try {
    const result = await leaveService.update(req.params.id, req.body, req.user, req.query);
    res.status(200).json({ success: true, data: result });
  } catch (error) { next(error); }
};

// ─── LEAVE BALANCE ────────────────────────────────────────────────────────────

exports.initializeLeaveBalance = async (req, res, next) => {
  try {
    const balance = await leaveService.initializeLeaveBalance(req.body, req.user);
    res.status(201).json({ success: true, message: "Leave balance initialized successfully", data: balance });
  } catch (error) { next(error); }
};

exports.getMyLeaveBalances = async (req, res, next) => {
  try {
    const result = await leaveService.getMyLeaveBalances(req.query, req.user);
    res.status(200).json({ success: true, message: "Your leave balances fetched successfully", data: result });
  } catch (error) { next(error); }
};

exports.getLeaveBalances = async (req, res, next) => {
  try {
    const result = await leaveService.getLeaveBalances(req.params.employeeId, req.query, req.user);
    res.status(200).json({ success: true, message: "Leave balances fetched successfully", data: result });
  } catch (error) { next(error); }
};

exports.adjustLeaveBalance = async (req, res, next) => {
  try {
    const balance = await leaveService.adjustLeaveBalance(req.params.id, req.body, req.user);
    res.status(200).json({ success: true, message: "Leave balance adjusted successfully", data: balance });
  } catch (error) { next(error); }
};

// ─── LEAVE REQUESTS (used by leave.route.js) ──────────────────────────────────

// POST /leave — apply leave
exports.applyLeave = async (req, res, next) => {
  try {
    const result = await leaveRequestService.applyLeave(req.body, req.user);
    res.status(201).json({ success: true, message: "Leave applied successfully", data: result });
  } catch (err) { next(err); }
};

// GET /leave — employee: their own leaves, HR: all leaves in their unit
exports.getAllLeaveRequests = async (req, res, next) => {
  try {
    const result = await leaveRequestService.getAllLeaveRequests(req.query, req.user);
    res.status(200).json({ success: true, message: "Leave requests fetched", data: result });
  } catch (err) { next(err); }
};

// GET /leave/:id — single leave request
exports.getLeaveRequestById = async (req, res, next) => {
  try {
    const result = await leaveRequestService.getLeaveRequestById(req.params.id, req.user);
    res.status(200).json({ success: true, data: result });
  } catch (err) { next(err); }
};

// PATCH /leave/:id — approve / reject
exports.updateLeaveStatus = async (req, res, next) => {
  try {
    const result = await leaveRequestService.updateLeaveStatus(req.params.id, req.body, req.user);
    res.status(200).json({ success: true, message: "Leave status updated", data: result });
  } catch (err) { next(err); }
};

// DELETE /leave/types/:id
exports.removeLeaveType = async (req, res, next) => {
  try {
    const result = await leaveService.remove(req.params.id, req.user, req.query);
    res.status(200).json({ success: true, message: result.message });
  } catch (err) { next(err); }
};

// DELETE /leave/:id — cancel leave request
exports.remove = async (req, res, next) => {
  try {
    const result = await leaveRequestService.cancelLeaveRequest(req.params.id, req.user, req.body?.reason);
    res.status(200).json({ success: true, message: result.message });
  } catch (err) { next(err); }
};

// PATCH /leave/:id/toggle-status — cancel leave request (alternate)
exports.toggleStatus = async (req, res, next) => {
  try {
    const result = await leaveRequestService.cancelLeaveRequest(req.params.id, req.user, req.body?.reason);
    res.status(200).json({ success: true, message: result.message });
  } catch (err) { next(err); }
};
exports.getPendingApprovals = async (req, res, next) => {
  try {
    const data = await leaveRequestService.getPendingApprovals(req.query, req.user);
    res.json({ success: true, message: "Pending approvals fetched", data });
  } catch (err) { next(err); }
};

// PATCH /leave/:id cancel (explicit)
exports.cancelLeave = async (req, res, next) => {
  try {
    const result = await leaveRequestService.cancelLeaveRequest(req.params.id, req.user, req.body?.reason);
    res.status(200).json({ success: true, message: result.message });
  } catch (err) { next(err); }
};
// ─── TEAM LEAVE CALENDAR ──────────────────────────────────────
// GET /leave/calendar?month=YYYY-MM&unit_id=&department_id=
exports.getTeamCalendar = async (req, res, next) => {
  try {
    const result = await leaveService.getTeamCalendar(req.query, req.user);
    res.status(200).json({ success: true, data: result });
  } catch (error) { next(error); }
};

// ─── LEAVE LIABILITY REPORT ───────────────────────────────────
// GET /leave/reports/liability?unit_id=&department_id=&asOfDate=
exports.getLeaveLiabilityReport = async (req, res, next) => {
  try {
    const result = await leaveService.getLeaveLiabilityReport(req.query, req.user);
    res.status(200).json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.editLeaveRequest = async (req, res, next) => {
  try {
    const result = await leaveRequestService.editLeaveRequest(req.params.id, req.body, req.user);
    res.json({ success: true, message: "Leave request updated", data: result });
  } catch (error) { next(error); }
};