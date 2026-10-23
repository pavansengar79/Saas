// modules/payrollPolicy/payslip/payslipPdf.service.js
"use strict";

const Payslip = require('../models/payslip.model')
const mongoose = require('mongoose')
const PDFDocument = require("pdfkit");
const AppError = require("../../../utils/appError");
const Employee = require("../../employee/models/employee.model");

const toObjId = id => new mongoose.Types.ObjectId(String(id));
const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const addAmountRow = (doc, label, amount) => {
  const y = doc.y;
  doc.text(label, 72, y, { continued: false });
  doc.text(`Rs. ${Number(amount || 0).toFixed(2)}`, 340, y, { width: 180, align: "right" });
};

const addSectionTitle = (doc, title) => {
  doc.moveDown(0.8).font("Helvetica-Bold").fontSize(11).text(title);
  doc.moveTo(72, doc.y + 2).lineTo(540, doc.y + 2).strokeColor("#C7CDD4").stroke();
  doc.moveDown(0.5).font("Helvetica").fontSize(10);
};

/**
 * Renders a payslip as a valid PDF buffer.
 * @param {object} payslip Populated payslip document.
 * @returns {Promise<Buffer>} PDF bytes.
 */
const renderPayslipPdf = payslip => new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: "A4", margin: 72, info: { Title: "Payslip" } });
  const chunks = [];
  doc.on("data", chunk => chunks.push(chunk));
  doc.on("end", () => resolve(Buffer.concat(chunks)));
  doc.on("error", reject);

  const employee = payslip.employee_id || {};
  const period = `${monthNames[payslip.month - 1] || payslip.month} ${payslip.year}`;

  doc.font("Helvetica-Bold").fontSize(20).text("PAYSLIP", { align: "center" });
  doc.font("Helvetica").fontSize(11).text(period, { align: "center" });
  doc.moveDown(1.5);
  doc.font("Helvetica-Bold").text(employee.name || "Employee");
  doc.font("Helvetica").fontSize(10);
  doc.text(`Employee ID: ${employee.employeeId || "N/A"}`);
  doc.text(`Email: ${employee.email || "N/A"}`);
  doc.text(`Department: ${employee.departmentId?.name || "N/A"}`);
  doc.text(`Designation: ${employee.designationId?.name || "N/A"}`);

  addSectionTitle(doc, "SALARY DETAILS");
  const summaryY = doc.y;
  const summaryColumnWidth = 117;
  [
    ["CYCLE CALENDAR DAYS", payslip.actualPayableDays],
    ["ELIGIBLE WORKDAYS", payslip.eligibleWorkingDays],
    ["LOSS OF PAY DAYS", payslip.lopDays],
    ["DAYS PAYABLE", payslip.daysPayable],
  ].forEach(([label, value], index) => {
    const x = 72 + index * summaryColumnWidth;
    doc.font("Helvetica").fontSize(8).text(label, x, summaryY, { width: summaryColumnWidth - 8 });
    doc.font("Helvetica-Bold").fontSize(12).text(String(value ?? "N/A"), x, summaryY + 14);
  });
  doc.x = 72;
  doc.y = summaryY + 34;
  doc.font("Helvetica").fontSize(10);
  if (payslip.eligibleCalendarDays != null) {
    doc.text(`Eligible calendar days (since joining): ${payslip.eligibleCalendarDays}`, 72);
  }

  addSectionTitle(doc, "EARNINGS");
  addAmountRow(doc, "Basic", payslip.earnings?.basic);
  addAmountRow(doc, "HRA", payslip.earnings?.hra);
  addAmountRow(doc, "Travel allowance", payslip.earnings?.travelAllowance);
  addAmountRow(doc, "Medical allowance", payslip.earnings?.medicalAllowance);
  addAmountRow(doc, "Special allowance", payslip.earnings?.specialAllowance);
  // PF-1: custom components (DA, food, internet …)
  for (const item of payslip.earnings?.customComponents || []) {
    if (Number(item?.amount) > 0) addAmountRow(doc, item.name || item.code || "Allowance", item.amount);
  }
  addAmountRow(doc, `Overtime (${payslip.overtimeHours || 0} hrs x ${payslip.overtimeMultiplier || 0})`, payslip.earnings?.overtime);
  addAmountRow(doc, "Gross salary", payslip.grossSalary);

  addSectionTitle(doc, "DEDUCTIONS");
  addAmountRow(doc, "Provident fund", payslip.deductions?.pf);
  addAmountRow(doc, "ESI", payslip.deductions?.esi);
  addAmountRow(doc, "TDS", payslip.deductions?.tds);
  addAmountRow(doc, "Professional tax", payslip.deductions?.professionalTax);
  // Only show LOP when something was actually deducted (it is off when the policy disables LOP)
  if (Number(payslip.deductions?.lop) > 0) addAmountRow(doc, `Loss of pay (${payslip.lopDays || 0} days)`, payslip.deductions.lop);
  addAmountRow(doc, "Gross after LOP", payslip.grossAfterLOP);

  addSectionTitle(doc, "NET PAY");
  doc.font("Helvetica-Bold").fontSize(14);
  addAmountRow(doc, "Net salary", payslip.netSalary);
  doc.moveDown(1.5).font("Helvetica").fontSize(9).fillColor("#5F6B76");
  doc.text(`Status: ${payslip.status}`);
  doc.text("This is a system-generated payslip.");
  doc.end();
});

/**
 * Generates an authorized PDF download for a payslip.
 * @param {string} payslipId Payslip ID.
 * @param {object} user Authenticated user.
 * @returns {Promise<{buffer: Buffer, filename: string, mimeType: string}>} PDF response.
 */
exports.generatePayslipPdf = async (payslipId, user) => {
  if (!mongoose.Types.ObjectId.isValid(payslipId)) {
    throw new AppError("Invalid payslip ID", 400);
  }

  const filter = { _id: toObjId(payslipId), isDeleted: false };
  if (user.role !== "SUPER_ADMIN" && user.orgId) filter.org_id = toObjId(user.orgId);
  if (user.companyId) filter.company_id = toObjId(user.companyId);

  if (user.role === "employee") {
    const employee = await Employee.findOne({
      userId: toObjId(user.userId),
      org_id: toObjId(user.orgId),
      company_id: toObjId(user.companyId),
      isDeleted: false,
    }).select("_id").lean();

    if (!employee) throw new AppError("Employee record not found", 404);
    filter.employee_id = employee._id;
    filter.status = { $in: ["PUBLISHED", "PAID"] };
  } else if (user.unitId) {
    filter.unit_id = toObjId(user.unitId);
  }

  const payslip = await Payslip.findOne(filter)
    .populate("employee_id", "name employeeId email departmentId designationId")
    .populate({ path: "employee_id", populate: [
      { path: "departmentId", select: "name" },
      { path: "designationId", select: "name" },
    ] })
    .lean();

  if (!payslip) throw new AppError("Payslip not found or not available", 404);

  const buffer = await renderPayslipPdf(payslip);
  const employeeName = String(payslip.employee_id?.name || "employee").replace(/[^a-z0-9_-]+/gi, "_");
  return {
    buffer,
    filename: `payslip_${payslip.month}_${payslip.year}_${employeeName}.pdf`,
    mimeType: "application/pdf",
  };
};

exports.renderPayslipPdf = renderPayslipPdf;
