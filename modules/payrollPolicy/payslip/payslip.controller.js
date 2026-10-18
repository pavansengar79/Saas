// modules/payrollPolicy/payslip.controller.js
// Complete payslip controller

"use strict";

const payslipService = require("./payslip.service");

// GET /api/v1/payslips/my — employee views their own payslips
exports.getMyPayslips = async (req, res, next) => {
  try {
    const data = await payslipService.getMyPayslips(req.query, req.user);
    res.json({ success: true, message: "Payslips fetched", data });
  } catch (err) { next(err); }
};

// GET /api/v1/payslips — HR all employees payslips
exports.getAllPayslips = async (req, res, next) => {
  try {
    const data = await payslipService.getAllPayslips(req.query, req.user);
    res.json({ success: true, message: "Payslips fetched", data });
  } catch (err) { next(err); }
};

// GET /api/v1/payslips/:id — single payslip
exports.getPayslipById = async (req, res, next) => {
  try {
    const data = await payslipService.getPayslipById(req.params.id, req.user);
    res.json({ success: true, message: "Payslip fetched", data });
  } catch (err) { next(err); }
};

// PATCH /api/v1/payslips/:id/publish — DRAFT → PUBLISHED + email
exports.publishPayslip = async (req, res, next) => {
  try {
    const data = await payslipService.publishPayslip(req.params.id, req.user);
    res.json({ success: true, message: "Payslip published and email sent to employee", data });
  } catch (err) { next(err); }
};

// PATCH /api/v1/payslips/publish-all — bulk publish for a month
exports.publishAllPayslips = async (req, res, next) => {
  try {
    const data = await payslipService.publishAllPayslips(req.body, req.user);
    res.json({ success: true, message: data.message, data });
  } catch (err) { next(err); }
};

// PATCH /api/v1/payslips/:id/mark-paid — PUBLISHED → PAID
exports.markAsPaid = async (req, res, next) => {
  try {
    const data = await payslipService.markAsPaid(req.params.id, req.body, req.user);
    res.json({ success: true, message: "Payslip marked as PAID", data });
  } catch (err) { next(err); }
};

// PATCH /api/v1/payslips/:id/revise — PUBLISHED / PAID only, reason required
exports.revisePayslip = async (req, res, next) => {
  try {
    const data = await payslipService.revisePayslip(req.params.id, req.body, req.user);
    res.json({ success: true, message: "Payslip revised", data });
  } catch (err) { next(err); }
};

// DELETE /api/v1/payslips/:id — only DRAFT
exports.deletePayslip = async (req, res, next) => {
  try {
    const data = await payslipService.deletePayslip(req.params.id, req.user);
    res.json({ success: true, message: data.message });
  } catch (err) { next(err); }
};
