// modules/payrollPolicy/payslip.service.js
// Complete payslip service — GET, publish, pay, email

"use strict";

const mongoose  = require("mongoose");
const Payslip   = require("../models/payslip.model");
const Employee  = require("../../employee/models/employee.model");
const Attendance = require("../../attendance/models/attendance.model");
const Holiday = require("../../holiday/models/holiday.models");
const LeaveRequest = require("../../leave/models/leaveRequest.models");
const LeaveType = require("../../leave/models/leaveType.models");
const CompanyConfig = require("../../companyConfig/models/companyConfig.model");
const Company   = require("../../company/models/company.model");
const User      = require("../../auth/models/user.model");
const AppError  = require("../../../utils/appError");
const { sendEmail }                = require("../../../utils/email/email");
const { payslipPublishedTemplate } = require("../../../utils/email/templates/payslipEmail");
const lockService = require("../payrollLock.service"); // Import lock service
const { buildPayrollScope } = require("../payrollScope");
const { buildPayslipCalendar } = require("./payslipCalendar");

const toObjId = (id) => new mongoose.Types.ObjectId(String(id));
const withPayableCalendarDays = payslip => {
  const { daysPayable, eligibleCalendarDays, eligibleWorkingDays } = payslip;
  const payableOffDays = daysPayable != null && eligibleCalendarDays != null && eligibleWorkingDays != null
    && eligibleCalendarDays >= eligibleWorkingDays && daysPayable <= eligibleWorkingDays
    ? eligibleCalendarDays - eligibleWorkingDays
    : null;

  return {
    ...payslip,
    payableOffDays,
    payableCalendarDays: payableOffDays == null ? null : daysPayable + payableOffDays,
  };
};

// ─────────────────────────────────────────────────────────────
// GET MY PAYSLIPS (Employee self-service) — P-18
// GET /api/v1/payslips/my
// ─────────────────────────────────────────────────────────────
exports.getMyPayslips = async (query, user) => {
  // Find employee record linked to this user
  const employee = await Employee.findOne({
    userId:     toObjId(user.userId),
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    isDeleted:  false,
  }).select("_id name employeeId email").lean();

  if (!employee) throw new AppError("Employee record not found for your account", 404);

  const { year, status, page = 1, limit = 12 } = query;

  const filter = {
    employee_id: employee._id,
    company_id:  toObjId(user.companyId),
    isDeleted:   false,
  };

  // Employees can only see PUBLISHED or PAID payslips — not DRAFT
  filter.status = { $in: ["PUBLISHED", "PAID"] };

  if (year)   filter.year   = Number(year);
  if (status && ["PUBLISHED", "PAID"].includes(status)) filter.status = status;

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await Payslip.countDocuments(filter);

  const payslips = await Payslip.find(filter)
    .sort({ year: -1, month: -1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  return {
    employee: {
      _id:        employee._id,
      name:       employee.name,
      employeeId: employee.employeeId,
    },
    payslips: payslips.map(withPayableCalendarDays),
    pagination: {
      total,
      page:  Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

// ─────────────────────────────────────────────────────────────
// GET ALL PAYSLIPS — HR/Admin view — P-13
// GET /api/v1/payslips
// ─────────────────────────────────────────────────────────────
exports.getAllPayslips = async (query, user) => {
  const {
    employeeId, year, month, status,
    page = 1, limit = 20,
  } = query;

  const filter = buildPayrollScope(user);
  console.log('[PAYSLIP SERVICE] User:', user.role, '| unitId:', user.unitId);
  console.log('[PAYSLIP SERVICE] Filter BEFORE:', JSON.stringify(filter));

  // Handle month - can be numeric (7) or date format (YYYY-MM)
  if (month) {
    const monthStr = String(month);
    if (monthStr.includes('-')) {
      const parts = monthStr.split('-');
      const parsedMonth = parseInt(parts[1], 10);
      if (!isNaN(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12) {
        filter.month = parsedMonth;
      }
      if (!year) {
        const parsedYear = parseInt(parts[0], 10);
        if (!isNaN(parsedYear)) filter.year = parsedYear;
      }
    } else {
      const parsedMonth = parseInt(monthStr, 10);
      if (!isNaN(parsedMonth)) filter.month = parsedMonth;
    }
  }
  if (year) {
    const parsedYear = parseInt(String(year), 10);
    if (!isNaN(parsedYear)) filter.year = parsedYear;
  }
  if (status)     filter.status = status;
  if (employeeId) filter.employee_id = toObjId(employeeId);

  console.log('[PAYSLIP SERVICE] Filter AFTER:', JSON.stringify(filter));
  
  const skip  = (Number(page) - 1) * Number(limit);
  const total = await Payslip.countDocuments(filter);
  console.log('[PAYSLIP SERVICE] Total documents found:', total);

  const payslips = await Payslip.find(filter)
    .populate("employee_id", "name employeeId email unit_id")
    .populate("generatedBy", "name email")
    .populate("approvedBy",  "name email")
    .sort({ year: -1, month: -1, createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  return {
    payslips: payslips.map(withPayableCalendarDays),
    pagination: {
      total,
      page:  Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  };
};

// ─────────────────────────────────────────────────────────────
// GET SINGLE PAYSLIP — P-16
// GET /api/v1/payslips/:id
// ─────────────────────────────────────────────────────────────
exports.getPayslipById = async (id, user) => {
  const filter = { _id: toObjId(id), ...buildPayrollScope(user) };

  if (user.role === "employee") {
    const employee = await Employee.findOne({
      userId: toObjId(user.userId),
      ...buildPayrollScope(user),
    }).select("_id").lean();

    if (!employee) throw new AppError("Employee record not found for your account", 404);
    filter.employee_id = employee._id;
    filter.status = { $in: ["PUBLISHED", "PAID"] };
  }

  const payslip = await Payslip.findOne(filter)
    .populate("employee_id", "name employeeId email unit_id departmentId designationId")
    .populate("generatedBy", "name email")
    .populate("approvedBy",  "name email")
    .lean();

  if (!payslip) throw new AppError("Payslip not found", 404);

  const start = new Date(Date.UTC(payslip.year, payslip.month - 1, 1));
  const end = new Date(Date.UTC(payslip.year, payslip.month, 1) - 1);
  const scope = { org_id: payslip.org_id, company_id: payslip.company_id };
  const employeeId = payslip.employee_id._id;
  const [attendance, holidays, leaves, config, employee] = await Promise.all([
    Attendance.find({ ...scope, employeeId, date: { $gte: start, $lte: end } }).select("date status isLWP").lean(),
    Holiday.find({ ...scope, $or: [{ unit_id: payslip.unit_id || null }, { unit_id: null }],
      date: { $gte: start, $lte: end }, type: { $in: ["NATIONAL", "COMPANY"] }, isActive: true, isDeleted: false })
      .select("date name").lean(),
    LeaveRequest.find({ ...scope, employeeId, status: "APPROVED", startDate: { $lte: end }, endDate: { $gte: start } })
      .select("startDate endDate isHalfDay leaveTypeId").lean(),
    CompanyConfig.findOne({ company_id: payslip.company_id }).select("timezone workWeek").lean(),
    Employee.findById(employeeId).select("joiningDate exitDate").lean(),
  ]);
  const paidTypes = leaves.length ? await LeaveType.find({
    _id: { $in: leaves.map(leave => leave.leaveTypeId) }, company_id: payslip.company_id, isPaid: true,
  }).select("_id").lean() : [];
  const calendar = buildPayslipCalendar({
    payslip, attendance, holidays, leaves,
    paidLeaveTypeIds: new Set(paidTypes.map(type => String(type._id))),
    workWeek: config?.workWeek, timezone: config?.timezone || "Asia/Kolkata",
    joiningDate: employee?.joiningDate, exitDate: employee?.exitDate,
  });

  return withPayableCalendarDays({
    ...payslip,
    calendar,
    daysPayable: payslip.daysPayable ?? (
      payslip.eligibleWorkingDays != null && payslip.lopDays != null
        ? Math.max(0, payslip.eligibleWorkingDays - payslip.lopDays)
        : null
    ),
  });
};

// ─────────────────────────────────────────────────────────────
// PUBLISH PAYSLIP — P-10, P-17, N-04
// PATCH /api/v1/payslips/:id/publish
// Sends email + in-app notification to employee
// Matrix Requirement: Payslip Published (🔔+📧+📱) Priority: 🔴 Critical
// ─────────────────────────────────────────────────────────────
exports.publishPayslip = async (id, user) => {
  const payslip = await Payslip.findOne({
    _id: toObjId(id),
    ...buildPayrollScope(user),
  }).populate("employee_id", "name employeeId email userId unit_id org_id salary");

  if (!payslip) throw new AppError("Payslip not found", 404);

  // ── MANDATORY: Check payroll period lock before publishing ───
  const isLocked = await lockService.isPeriodLocked(
    payslip.month,
    payslip.year,
    payslip.org_id || user.orgId,
    payslip.unit_id,
    payslip.company_id
  );
  if (!isLocked) {
    throw new AppError(
      `Cannot publish payslip: Payroll period ${payslip.month}/${payslip.year} must be locked first.`,
      423
    );
  }

  if (payslip.status !== "DRAFT") {
    throw new AppError(`Payslip is already ${payslip.status}. Only DRAFT can be published.`, 400);
  }

  const salary = payslip.employee_id?.salary;
  if (!salary || ![salary.basic, salary.hra, salary.travelAllowance, salary.medicalAllowance, salary.specialAllowance]
    .some(component => Number(component) > 0)) {
    throw new AppError("Employee has no assigned salary structure; rerun payroll after assigning salary", 400);
  }
  if (![payslip.earnings?.basic, payslip.earnings?.hra, payslip.earnings?.travelAllowance,
    payslip.earnings?.medicalAllowance, payslip.earnings?.specialAllowance]
    .some(component => Number(component) > 0)) {
    throw new AppError("Payslip has no calculated salary earnings; rerun payroll before publishing", 400);
  }

  payslip.status     = "PUBLISHED";
  payslip.approvedBy = toObjId(user.userId);
  payslip.approvedAt = new Date();
  await payslip.save();

  const employee = payslip.employee_id;
  
  // Get company name for email
  let companyName = "Your Company";
  try {
    const company = await Company.findById(payslip.company_id)
      .select("company_name brand_name").lean();
    companyName = company?.brand_name || company?.company_name || "Your Company";
  } catch (e) {
    console.error("Company lookup failed:", e.message);
  }

  // N-04: Send email to employee — Matrix Requirement: 📧 Email
  if (employee?.email) {
    try {
      await sendEmail({
        to:      employee.email,
        subject: `Your Payslip for ${_monthName(payslip.month)} ${payslip.year} is Ready`,
        html:    payslipPublishedTemplate({
          employeeName:    employee.name,
          employeeId:      employee.employeeId,
          month:           payslip.month,
          year:            payslip.year,
          companyName,
          earnings:        payslip.earnings,
          deductions:      payslip.deductions,
          grossSalary:     payslip.grossSalary,
          netSalary:       payslip.netSalary,
          totalWorkingDays: payslip.totalWorkingDays,
          daysPresent:     payslip.daysPresent,
          lopDays:         payslip.lopDays,
          overtimeHours:   payslip.overtimeHours,
        }),
      });
      console.log(`✅ Payslip email sent to ${employee.email}`);
    } catch (emailErr) {
      // Non-fatal — payslip published even if email fails
      console.error("⚠️  Payslip email failed:", emailErr.message);
    }
  }

  // N-04: In-App + Push Notification — Matrix Requirement: 🔔+📱
  if (employee?.userId) {
    try {
      const sendNotification = require("../../../utils/sendNotification");
      
      await sendNotification({
        type:          "PAYSLIP_PUBLISHED",
        userId:        employee.userId,
        org_id:        payslip.org_id || employee.org_id,
        unit_id:       employee.unit_id,
        referenceId:   payslip._id,
        referenceType: "Payslip",
        data: {
          employeeName:    employee.name,
          employeeId:      employee.employeeId,
          month:           _monthName(payslip.month),
          year:            payslip.year,
          netSalary:       payslip.netSalary,
          companyName,
          payslipId:       payslip._id,
        },
        inApp:  true,   // In-app notification ✓
        email:  false,  // Email already sent above
        push:   true    // Push notification ✓
      });
      
      console.log(`[publishPayslip] ✅ In-app + Push notification sent to employee ${employee.userId}`);
    } catch (notifErr) {
      // Non-fatal — payslip published even if notification fails
      console.error("[publishPayslip] ⚠️ Notification failed:", notifErr.message);
    }
  }

  return payslip;
};

// ─────────────────────────────────────────────────────────────
// PUBLISH ALL PAYSLIPS FOR A MONTH — Bulk publish
// PATCH /api/v1/payslips/publish-all
// ─────────────────────────────────────────────────────────────
exports.publishAllPayslips = async (body, user) => {
  const { month, year } = body;
  if (!month || !year) throw new AppError("month and year required", 400);

  // ── MANDATORY: Check payroll period lock before bulk publishing ───
  const isLocked = await lockService.isPeriodLocked(
    Number(month),
    Number(year),
    user.orgId,
    user.unitId,
    user.companyId
  );
  if (!isLocked) {
    throw new AppError(
      `Cannot publish payslips: Payroll period ${month}/${year} must be locked first.`,
      423
    );
  }

  const filter = {
    company_id: toObjId(user.companyId),
    month:      Number(month),
    year:       Number(year),
    status:     "DRAFT",
    isDeleted:  false,
  };

  if (user.unitId) filter.unit_id = toObjId(user.unitId);

  const drafts = await Payslip.find(filter)
    .populate("employee_id", "name employeeId email salary");

  if (!drafts.length) {
    throw new AppError(`No DRAFT payslips found for ${_monthName(month)} ${year}`, 404);
  }

  const company = await Company.findById(user.companyId)
    .select("company_name brand_name").lean();
  const companyName = company?.brand_name || company?.company_name || "Your Company";

  let published = 0;
  let failed    = 0;
  const errors  = [];

  for (const payslip of drafts) {
    try {
      const salary = payslip.employee_id?.salary;
      if (!salary || ![salary.basic, salary.hra, salary.travelAllowance, salary.medicalAllowance, salary.specialAllowance]
        .some(component => Number(component) > 0)) {
        throw new AppError("Employee has no assigned salary structure; rerun payroll after assigning salary", 400);
      }
      if (![payslip.earnings?.basic, payslip.earnings?.hra, payslip.earnings?.travelAllowance,
        payslip.earnings?.medicalAllowance, payslip.earnings?.specialAllowance]
        .some(component => Number(component) > 0)) {
        throw new AppError("Payslip has no calculated salary earnings; rerun payroll before publishing", 400);
      }

      payslip.status     = "PUBLISHED";
      payslip.approvedBy = toObjId(user.userId);
      payslip.approvedAt = new Date();
      await payslip.save();
      published++;

      // Send email
      const emp = payslip.employee_id;
      if (emp?.email) {
        sendEmail({
          to:      emp.email,
          subject: `Your Payslip for ${_monthName(payslip.month)} ${payslip.year} is Ready`,
          html:    payslipPublishedTemplate({
            employeeName:     emp.name,
            employeeId:       emp.employeeId,
            month:            payslip.month,
            year:             payslip.year,
            companyName,
            earnings:         payslip.earnings,
            deductions:       payslip.deductions,
            grossSalary:      payslip.grossSalary,
            netSalary:        payslip.netSalary,
            totalWorkingDays: payslip.totalWorkingDays,
            daysPresent:      payslip.daysPresent,
            lopDays:          payslip.lopDays,
            overtimeHours:    payslip.overtimeHours,
          }),
        }).catch(e => console.error(`Email failed for ${emp.email}:`, e.message));
      }
    } catch (err) {
      failed++;
      errors.push({ employeeId: payslip.employee_id?._id, error: err.message });
    }
  }

  return {
    month, year,
    summary: { published, failed, errors },
    message: `Published ${published} payslips. Failed: ${failed}.`,
  };
};

// ─────────────────────────────────────────────────────────────
// MARK AS PAID
// PATCH /api/v1/payslips/:id/mark-paid
// ─────────────────────────────────────────────────────────────
exports.markAsPaid = async (id, body, user) => {
  const { paymentDate, paymentMode, transactionRef } = body;

  const payslip = await Payslip.findOne({
    _id: toObjId(id),
    ...buildPayrollScope(user),
  });

  if (!payslip) throw new AppError("Payslip not found", 404);

  if (payslip.status !== "PUBLISHED") {
    throw new AppError("Only PUBLISHED payslips can be marked as PAID", 400);
  }

  payslip.status         = "PAID";
  payslip.paymentDate    = paymentDate || new Date();
  payslip.paymentMode    = paymentMode || "BANK_TRANSFER";
  payslip.transactionRef = transactionRef || null;
  await payslip.save();

  return payslip;
};

// ─────────────────────────────────────────────────────────────
// REVISE — correct a PUBLISHED / PAID payslip with a reason (P0-7)
// PATCH /api/v1/payslips/:id/revise
// body: { reason, earnings?: { bonus: 5000 }, deductions?: { tds: 1200 } }
// ─────────────────────────────────────────────────────────────
exports.revisePayslip = async (id, body, user) => {
  const { applyPayslipRevision } = require("./payslipRevision");
  const payslip = await Payslip.findOne({
    _id: toObjId(id),
    isDeleted: { $ne: true },
    ...buildPayrollScope(user),
  });
  if (!payslip) throw new AppError("Payslip not found", 404);

  applyPayslipRevision(payslip, body, user.userId);
  await payslip.save();
  return payslip;
};

// ─────────────────────────────────────────────────────────────
// DELETE (soft) — only DRAFT can be deleted
// DELETE /api/v1/payslips/:id
// ─────────────────────────────────────────────────────────────
exports.deletePayslip = async (id, user) => {
  const payslip = await Payslip.findOne({
    _id: toObjId(id),
    ...buildPayrollScope(user),
  });

  if (!payslip) throw new AppError("Payslip not found", 404);

  if (payslip.status !== "DRAFT") {
    throw new AppError(`Cannot delete ${payslip.status} payslip. Only DRAFT can be deleted.`, 400);
  }

  payslip.isDeleted = true;
  await payslip.save();

  return { message: "Payslip deleted successfully" };
};

// ─── Helper ───────────────────────────────────────────────────
const _monthName = (m) =>
  ["January","February","March","April","May","June",
   "July","August","September","October","November","December"][m - 1] || "";
