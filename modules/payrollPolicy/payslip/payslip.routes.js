// modules/payrollPolicy/payslip.routes.js
// Payslip routes — P-10, P-13, P-16, P-17, P-18, N-04
const checkPermission = require("../../../middlewares/permission.middleware");

"use strict";

const express = require("express");
const router  = express.Router();

const { authenticate }  = require("../../../middlewares/auth.middleware");
const { checkRole }     = require("../../../middlewares/checkRole.middleware");
const checkTrial        = require("../../../middlewares/checkTrial.middleware");
const ctrl              = require("./payslip.controller");
const pdfCtrl           = require("./payslipPdf.controller");

// All routes require auth + trial check
router.use(authenticate, checkTrial);

// ── Employee self-service ─────────────────────────────────────
// IMPORTANT: /my MUST be before /:id to avoid conflict
// GET /api/v1/payslips/my?year=2026&status=PUBLISHED
router.get("/my", checkPermission("payroll.read"), ctrl.getMyPayslips);
router.get("/",              checkPermission("payroll.read"),   ctrl.getAllPayslips);
router.patch("/publish-all", checkPermission("payroll.run"),    ctrl.publishAllPayslips);
router.get("/:id",           checkPermission("payroll.read"),   ctrl.getPayslipById);
router.get("/:id/pdf",       checkPermission("payroll.read"),   pdfCtrl.downloadPayslipPdf);
router.patch("/:id/publish", checkPermission("payroll.run"),    ctrl.publishPayslip);
router.patch("/:id/mark-paid", checkPermission("payroll.run"),  ctrl.markAsPaid);
router.patch("/:id/revise",  checkPermission("payroll.run"),    ctrl.revisePayslip);
router.delete("/:id",        checkPermission("payroll.run"),    ctrl.deletePayslip);

module.exports = router;
