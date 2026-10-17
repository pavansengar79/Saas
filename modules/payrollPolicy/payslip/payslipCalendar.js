"use strict";

const moment = require("moment-timezone");

const dateKey = (date, timezone) => moment(date).tz(timezone).format("YYYY-MM-DD");
const cents = amount => Math.round((Number(amount) || 0) * 100);

function buildPayslipCalendar({ payslip, attendance, holidays, leaves, paidLeaveTypeIds, workWeek, timezone, joiningDate, exitDate }) {
  const monthStart = moment.tz(`${payslip.year}-${String(payslip.month).padStart(2, "0")}-01`, timezone);
  const monthEnd = monthStart.clone().endOf("month");
  const today = moment().tz(timezone).endOf("day");
  const cutoff = payslip.calculatedThrough
    ? moment.tz(new Date(payslip.calculatedThrough).toISOString().slice(0, 10), "YYYY-MM-DD", timezone)
    : monthEnd;
  const last = moment.min(monthEnd, cutoff, today);
  const workDays = new Set(workWeek || ["MON", "TUE", "WED", "THU", "FRI"]);
  const weekdayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const records = new Map(attendance.map(record => [dateKey(record.date, timezone), record]));
  const holidayByDay = new Map(holidays.map(holiday => [dateKey(holiday.date, timezone), holiday]));
  const leaveByDay = new Map();

  for (const leave of leaves) {
    const first = moment.max(monthStart, moment(leave.startDate).tz(timezone).startOf("day"));
    const end = moment.min(last, moment(leave.endDate).tz(timezone).startOf("day"));
    for (const day = first.clone(); day.isSameOrBefore(end, "day"); day.add(1, "day")) {
      const key = day.format("YYYY-MM-DD");
      if (!leaveByDay.has(key)) leaveByDay.set(key, leave);
    }
  }

  const days = [];
  for (const day = monthStart.clone(); day.isSameOrBefore(last, "day"); day.add(1, "day")) {
    const date = day.format("YYYY-MM-DD");
    const record = records.get(date);
    const holiday = holidayByDay.get(date);
    const leave = leaveByDay.get(date);
    const scheduled = workDays.has(weekdayNames[day.day()]);
    const employed = (!joiningDate || !day.isBefore(moment(joiningDate).tz(timezone), "day"))
      && (!exitDate || !day.isAfter(moment(exitDate).tz(timezone), "day"));
    let status = "OFF";
    let payable = 0;
    let unpaid = 0;
    if (!employed) status = "NOT_ELIGIBLE";
    else if (holiday || record?.status === "HOLIDAY") {
      status = "HOLIDAY";
      payable = scheduled || ["PRESENT", "WFH", "LATE"].includes(record?.status) ? 1 : 0;
    } else if (leave) {
      status = paidLeaveTypeIds.has(String(leave.leaveTypeId)) ? "PAID_LEAVE" : "UNPAID_LEAVE";
      if (scheduled) {
        const worked = ["PRESENT", "WFH", "LATE"].includes(record?.status) ? 1 : record?.status === "HALF_DAY" ? 0.5 : 0;
        const leaveUnits = leave.isHalfDay ? 0.5 : 1;
        payable = Math.min(1, worked + (status === "PAID_LEAVE" ? leaveUnits : 0));
        unpaid = Math.max(0, 1 - payable);
      }
    } else if (record?.status === "PRESENT" || record?.status === "WFH" || record?.status === "LATE") {
      status = record.status;
      payable = 1;
    } else if (record?.status === "HALF_DAY") {
      status = "HALF_DAY";
      payable = 0.5;
      unpaid = scheduled ? 0.5 : 0;
    } else if (record?.status === "ON_LEAVE" && !record.isLWP) {
      status = "PAID_LEAVE";
      payable = scheduled ? 1 : 0;
    } else if (scheduled) {
      status = record?.status === "ON_LEAVE" ? "UNPAID_LEAVE" : "ABSENT";
      unpaid = 1;
    }
    days.push({ date, status, label: holiday?.name || null, payable, unpaid, credit: 0, debit: 0 });
  }

  const recurring = ["basic", "hra", "travelAllowance", "medicalAllowance", "specialAllowance"]
    .reduce((sum, key) => sum + cents(payslip.earnings?.[key]), 0);
  const creditUnits = days.filter(day => day.status !== "NOT_ELIGIBLE").length;
  const lopUnits = days.reduce((sum, day) => sum + day.unpaid, 0);
  const savedLopDays = Number(payslip.lopDays);
  const allocateDailyLop = payslip.lopDays == null || Math.abs(lopUnits - savedLopDays) < 0.001;
  let allocatedCredit = { units: 0, amount: 0 };
  let allocatedDebit = { units: 0, amount: 0 };
  for (const day of days) {
    if (creditUnits && day.status !== "NOT_ELIGIBLE") {
      const next = Math.round(recurring * (allocatedCredit.units + 1) / creditUnits);
      day.credit = (next - allocatedCredit.amount) / 100;
      allocatedCredit = { units: allocatedCredit.units + 1, amount: next };
    }
    if (allocateDailyLop && lopUnits && day.unpaid) {
      const next = Math.round(cents(payslip.deductions?.lop) * (allocatedDebit.units + day.unpaid) / lopUnits);
      day.debit = (next - allocatedDebit.amount) / 100;
      allocatedDebit = { units: allocatedDebit.units + day.unpaid, amount: next };
    }
  }

  return {
    days,
    calculatedThrough: last.isBefore(monthStart) ? null : last.format("YYYY-MM-DD"),
    monthlyEarnings: (Number(payslip.grossSalary) || 0) - recurring / 100,
    monthlyDeductions: Object.entries(payslip.deductions || {})
      .filter(([key, value]) => key !== "lop" && Number(value) > 0)
      .map(([key, value]) => ({ label: key, amount: Number(value) }))
      .concat(!allocateDailyLop && Number(payslip.deductions?.lop) > 0
        ? [{ label: "LOP (saved payslip; daily records differ)", amount: Number(payslip.deductions.lop) }]
        : []),
  };
}

module.exports = { buildPayslipCalendar };