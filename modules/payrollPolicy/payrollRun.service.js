// modules/payrollPolicy/payrollRun.service.js
// T-30 — Complete Payroll Run Engine
// Handles: PF, ESI, TDS, LOP, Pro-rata, Payslip generation

"use strict";
const lockService = require("./payrollLock.service");

const AppError               = require("../../utils/appError");
const { resolveAttendancePolicy, resolvePayrollPolicy } = require("../../utils/policyResolver");
const {
  assertPayrollRunDateReached,
  calculateOvertimePay,
  calculatePayrollEligibility,
  assertPayslipCanBeRecalculated,
  resolveProfessionalTaxState,
  calculateStatutoryDeductions,
  getFinancialYear,
} = require("./payrollRunRules");
const Employee               = require("../employee/models/employee.model");
const Attendance             = require("../attendance/models/attendance.model");
const LeaveRequest           = require("../leave/models/leaveRequest.models");
const LeaveType              = require("../leave/models/leaveType.models");
const LeaveBalance           = require("../leave/models/leaveBalance.models");
const CompanyConfig          = require("../companyConfig/models/companyConfig.model");
const Company                = require("../company/models/company.model");
const Unit                   = require("../unit/models/unit.model");
const Payslip                = require("./models/payslip.model");
const InvestmentDeclaration  = require("./models/investmentDeclaration.model");
const mongoose               = require("mongoose");
const moment                 = require("moment-timezone");

// ─── Parse "YYYY-MM" → { year, month, start, end } ───────────
const parseMonth = (monthStr) => {
  if (!/^\d{4}-\d{2}$/.test(monthStr)) {
    throw new AppError('month must be "YYYY-MM"', 400);
  }
  const [year, month] = monthStr.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end   = new Date(Date.UTC(year, month, 1) - 1);
  return { year, month, start, end };
};

const getUnrecordedPaidLeaveDays = async (employee, company_id, start, end, timezone, workDayNumbers) => {
  const leaves = await LeaveRequest.find({
    org_id: employee.org_id,
    company_id,
    employeeId: employee._id,
    status: "APPROVED",
    startDate: { $lte: end },
    endDate: { $gte: start },
  }).select("startDate endDate leaveTypeId isHalfDay").lean();
  if (!leaves.length) return 0;

  const types = await LeaveType.find({
    _id: { $in: leaves.map(leave => leave.leaveTypeId) },
    company_id,
    isPaid: true,
  }).select("_id").lean();
  const paidTypeIds = new Set(types.map(type => String(type._id)));
  const records = await Attendance.find({
    employeeId: employee._id,
    company_id,
    date: { $gte: start, $lte: end },
  }).select("date status").lean();
  const statusByDay = new Map(records.map(record => [moment(record.date).tz(timezone).format("YYYY-MM-DD"), record.status]));
  const paidDays = new Map();

  for (const leave of leaves) {
    if (!paidTypeIds.has(String(leave.leaveTypeId))) continue;
    const first = moment.max(moment(leave.startDate).tz(timezone).startOf("day"), moment(start).tz(timezone).startOf("day"));
    const last = moment.min(moment(leave.endDate).tz(timezone).startOf("day"), moment(end).tz(timezone).startOf("day"));
    for (const day = first.clone(); day.isSameOrBefore(last, "day"); day.add(1, "day")) {
      if (!workDayNumbers.includes(day.day() + 1)) continue;
      const key = day.format("YYYY-MM-DD");
      paidDays.set(key, Math.max(paidDays.get(key) || 0, leave.isHalfDay ? 0.5 : 1));
    }
  }

  let credited = 0;
  for (const [day, duration] of paidDays) {
    const status = statusByDay.get(day);
    if (status === "HALF_DAY") credited += Math.min(duration, 0.5);
    else if (!status || status === "ABSENT") credited += duration;
  }
  return credited;
};

// ─────────────────────────────────────────────────────────────────────────────
// CALCULATE PAYROLL FOR ONE EMPLOYEE
// ─────────────────────────────────────────────────────────────────────────────

const calculateForEmployee = async (
  employee,
  company_id,
  unit_id,
  year,
  month,
  policy,
  config,
  statutoryLocation = {}
) => {
  const { start, end } = parseMonth(`${year}-${String(month).padStart(2, "0")}`);
  const attendancePolicy = await resolveAttendancePolicy(
    employee._id.toString(),
    company_id.toString(),
    unit_id?.toString() || null
  );

  const eligibility = calculatePayrollEligibility({
    year,
    month,
    joiningDate: employee.joiningDate,
    exitDate: employee.exitDate,
    workDays: config?.workWeek,
    startDay: policy?.salaryCycle?.startDay,
    endDay: policy?.salaryCycle?.endDay,
    fixedWorkingDays: policy?.salaryCycle?.workingDaysCalc === "fixed"
      ? policy.salaryCycle.fixedWorkingDays
      : undefined,
    proRata: policy?.proRata,
  });
  const { totalWorkingDays, monthlyWorkingDays, salaryDivisorDays, eligibleWorkingDays, proRataFactor } = eligibility;
  const timezone = config?.timezone || "Asia/Kolkata";
  const attendanceStart = moment.tz(eligibility.eligibilityStart.toISOString().slice(0, 10), "YYYY-MM-DD", timezone).startOf("day").toDate();
  const attendanceEnd = moment.tz(eligibility.eligibilityEnd.toISOString().slice(0, 10), "YYYY-MM-DD", timezone).endOf("day").toDate();
  const workDayNumbers = (config?.workWeek || ["MON", "TUE", "WED", "THU", "FRI"])
    .map(day => ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].indexOf(day) + 1)
    .filter(day => day > 0);
  const isWorkday = { $in: [{ $dayOfWeek: { date: "$date", timezone } }, workDayNumbers] };

  // ── Attendance summary ──────────────────────────────────────
  const attendanceSummary = await Attendance.aggregate([
    {
      $match: {
        employeeId: employee._id,
        company_id: new mongoose.Types.ObjectId(String(company_id)),
        date:       { $gte: attendanceStart, $lte: attendanceEnd },
      },
    },
    {
      $group: {
        _id:           null,
        present:       { $sum: { $cond: [{ $and: [isWorkday, { $in: ["$status", ["PRESENT", "WFH", "LATE"]] }] }, 1, 0] } },
        halfDay:       { $sum: { $cond: [{ $and: [isWorkday, { $eq: ["$status", "HALF_DAY"] }] }, 0.5, 0] } },
        weekendWorked: { $sum: { $cond: [{ $and: [{ $not: [isWorkday] }, { $in: ["$status", ["PRESENT", "WFH", "LATE"]] }] }, 1, 0] } },
        weekendHalfDay: { $sum: { $cond: [{ $and: [{ $not: [isWorkday] }, { $eq: ["$status", "HALF_DAY"] }] }, 0.5, 0] } },
        onLeave:       {
          $sum: {
            $cond: [
              { $and: [isWorkday, { $eq: ["$status", "ON_LEAVE"] }, { $ne: ["$isLWP", true] }] },
              1,
              0,
            ],
          },
        },
        holiday:       { $sum: { $cond: [{ $and: [isWorkday, { $eq: ["$status", "HOLIDAY"] }] }, 1, 0] } },
        overtimeHours: { $sum: { $ifNull: ["$overtimeHours", 0] } },
      },
    },
  ]);

  const att          = attendanceSummary[0] || { present: 0, halfDay: 0, weekendWorked: 0, weekendHalfDay: 0, onLeave: 0, holiday: 0, overtimeHours: 0 };
  const unrecordedPaidLeave = await getUnrecordedPaidLeaveDays(employee, company_id, attendanceStart, attendanceEnd, timezone, workDayNumbers);
  const regularDaysPresent = att.present + att.halfDay + att.onLeave + att.holiday + unrecordedPaidLeave;
  const extraDaysWorked = (att.weekendWorked || 0) + (att.weekendHalfDay || 0);
  const daysPresent = regularDaysPresent + extraDaysWorked;
  const daysPayable = Math.min(eligibleWorkingDays, regularDaysPresent) + extraDaysWorked;
  const lopDays = policy?.lop?.enabled === false ? 0 : Math.max(0, eligibleWorkingDays - regularDaysPresent);
  const earningsFactor = proRataFactor + (salaryDivisorDays ? extraDaysWorked / salaryDivisorDays : 0);

  const salary = employee.salary;
  if (!salary || ![salary.basic, salary.hra, salary.travelAllowance, salary.medicalAllowance, salary.specialAllowance]
    .some(component => Number(component) > 0)) {
    throw new AppError("Employee has no assigned salary structure", 400);
  }
  const basic  = (salary?.basic || 0) * earningsFactor;
  const hra    = (salary?.hra   || 0) * earningsFactor;
  const travel = (salary?.travelAllowance  || 0) * earningsFactor;
  const medical= (salary?.medicalAllowance || 0) * earningsFactor;
  const special= (salary?.specialAllowance || 0) * earningsFactor;

  // ── LOP calculation using policy formula ──────────────────────
  // Policy lop config: enabled, calculation ("per_day"/"per_hour"), perDayFormula, roundingRule
  const lopConfig = policy?.lop || {};
  const grossEarnings = basic + hra + travel + medical + special;
  const monthlyGross = (salary?.basic || 0) + (salary?.hra || 0)
    + (salary?.travelAllowance || 0) + (salary?.medicalAllowance || 0)
    + (salary?.specialAllowance || 0);
  
  // Get calendar days for the month
  const calendarDays = new Date(year, month, 0).getDate(); // e.g., 31 for July
  
  // Determine divisor based on perDayFormula
  let lopDivisorDays = 0;
  let formulaUsed = lopConfig.perDayFormula || 'monthly_salary/working_days';
  
  switch (lopConfig.perDayFormula) {
    case 'monthly_salary/calendar_days':
      lopDivisorDays = calendarDays;
      break;
    case 'monthly_salary/working_days':
      lopDivisorDays = salaryDivisorDays;
      break;
    case 'monthly_salary/30':
      lopDivisorDays = 30;
      break;
    case 'monthly_salary/26':
      lopDivisorDays = 26;
      break;
    default:
      lopDivisorDays = salaryDivisorDays;
  }
  
  // Calculate per-day rate
  const dailySalary = lopDivisorDays > 0 ? monthlyGross / lopDivisorDays : 0;
  const standardHours = config?.standardHoursPerDay || 8;
  const isHourlyLOP = lopConfig.calculation === "per_hour";
  if (isHourlyLOP) {
    formulaUsed = lopConfig.perHourFormula || "daily_rate/standard_hours";
  }
  const hourlyRate = formulaUsed === "monthly_salary/(working_days*standard_hours)"
    ? monthlyGross / ((salaryDivisorDays || 1) * standardHours)
    : dailySalary / standardHours;
  const lopDeductionRaw = isHourlyLOP
    ? lopDays * standardHours * hourlyRate
    : lopDays * dailySalary;
  
  // Apply rounding rule from policy
  let lopDeduction;
  switch (lopConfig.roundingRule) {
    case 'ceil':
    case 'up':
      lopDeduction = Math.ceil(lopDeductionRaw);
      break;
    case 'floor':
    case 'down':
      lopDeduction = Math.floor(lopDeductionRaw);
      break;
    case 'round':
    case 'nearest':
      lopDeduction = Math.round(lopDeductionRaw);
      break;
    default:
      lopDeduction = parseFloat(lopDeductionRaw.toFixed(2));
  }

  // ── Overtime pay ─────────────────────────────────────────────
  const overtimeWorkingDays = policy?.salaryCycle?.workingDaysCalc === "fixed"
    ? policy.salaryCycle.fixedWorkingDays
    : monthlyWorkingDays;
  const overtimeResult = calculateOvertimePay({
    detectedHours: att.overtimeHours || 0,
    attendanceOvertime: attendancePolicy.overtime,
    payrollOvertime: policy?.overtimePay,
    salary: {
      basic,
      hra,
      travelAllowance: travel,
      medicalAllowance: medical,
      specialAllowance: special,
      customComponents: (salary?.customComponents || []).map(component => ({
        ...component,
        amount: component.amount * earningsFactor,
      })),
    },
    workingDays: overtimeWorkingDays,
    standardHours: config?.standardHoursPerDay || 8,
  });
  const overtimeMultiplier = overtimeResult.multiplier;
  const overtimeRate = overtimeResult.rate;
  const overtimePay = overtimeResult.amount;
  att.overtimeHours = overtimeResult.hours;

  // ── Gross salary ─────────────────────────────────────────────
  const grossBeforeLOP = parseFloat((basic + hra + travel + medical + special + overtimePay).toFixed(2));
  const grossSalary    = parseFloat((grossBeforeLOP - lopDeduction).toFixed(2));

  // ── Statutory deductions ─────────────────────────────────────
  const ptState = resolveProfessionalTaxState({
    policyState: policy?.taxCompliance?.ptState,
    unitState: statutoryLocation.unitState,
    companyState: statutoryLocation.companyState,
    employeeState: employee?.location?.stateCode || employee?.currentAddress?.stateCode,
  });
  const payableBasic = Math.max(0, basic - lopDays * (salary?.basic || 0) / (lopDivisorDays || 1));
  const {
    pfEmployee,
    pfEmployer,
    esiEmployee,
    esiEmployer,
    professionalTax,
  } = calculateStatutoryDeductions({
    basic: payableBasic,
    fullBasic: salary.basic || 0,
    grossSalary,
    standardGross: monthlyGross,
    taxCompliance: policy?.taxCompliance,
    ptState,
  });

  // ── TDS Calculation (Old/New Regime) ──────────────────────────────────────
  const { calculateTDSOldRegime, calculateTDSNewRegime, STANDARD_DEDUCTION, NEW_REGIME_STANDARD_DEDUCTION } = require("../../config/tdsSlabs");
  const InvestmentDeclaration = require("./models/investmentDeclaration.model");
  
  let tds = 0;
  let taxBreakdown = null;
  
  if (policy?.tdsConfig?.enabled !== false) {
    try {
      // Get investment declaration for tax exemption
      const financialYear = getFinancialYear(year, month);
      const declaration = await InvestmentDeclaration.findOne({
        employee_id: employee._id,
        financialYear,
        status: { $in: ["APPROVED", "LOCKED"] }
      }).lean();
      
      const investments = declaration?.investments || [];
      const totalExemption = investments.reduce((sum, inv) => sum + (inv.approvedAmount || inv.declaredAmount || 0), 0);
      
      const regime = policy?.tdsConfig?.taxRegime || 'new';
      const annualGross = monthlyGross * 12;
      const taxableIncome = Math.max(0, annualGross - (regime === 'new' ? NEW_REGIME_STANDARD_DEDUCTION : STANDARD_DEDUCTION)
        - (regime === 'old' ? totalExemption : 0));
      
      // Calculate age for senior citizen exemption
      const age = employee.dateOfBirth ? Math.floor((new Date() - new Date(employee.dateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000)) : 30;
      const ageGroup = age >= 80 ? 'super_senior' : age >= 60 ? 'senior' : 'general';
      
      if (regime === 'new') {
        const tdsCalc = calculateTDSNewRegime(taxableIncome);
        tds = tdsCalc.monthlyTDS;
        taxBreakdown = tdsCalc;
      } else {
        const tdsCalc = calculateTDSOldRegime(taxableIncome, ageGroup);
        tds = tdsCalc.monthlyTDS;
        taxBreakdown = tdsCalc;
      }
    } catch (err) {
      throw new AppError(`TDS calculation failed: ${err.message}`, 500);
    }
  }

  // ── Net salary ───────────────────────────────────────────────
  const totalDeductions = parseFloat((pfEmployee + esiEmployee + tds + professionalTax + lopDeduction).toFixed(2));
  const netSalary       = parseFloat((grossSalary - (pfEmployee + esiEmployee + tds + professionalTax)).toFixed(2));

  // ── Calculate YTD (Year-to-Date) ─────────────────────────────────────────
  const ytdPayslips = await Payslip.find({
    employee_id: employee._id,
    year,
    month: { $lte: month },
    status: { $ne: "DRAFT" }
  }).lean();
  
  const ytd = {
    earnings: {
      basic: 0,
      hra: 0,
      travelAllowance: 0,
      medicalAllowance: 0,
      specialAllowance: 0,
      overtime: 0,
      bonus: 0,
      arrears: 0,
      totalEarnings: 0,
    },
    deductions: {
      pf: 0,
      esi: 0,
      tds: 0,
      professionalTax: 0,
      lop: 0,
      totalDeductions: 0,
    }
  };
  
  // Sum up previous months
  ytdPayslips.forEach(slip => {
    ytd.earnings.basic += slip.earnings?.basic || 0;
    ytd.earnings.hra += slip.earnings?.hra || 0;
    ytd.earnings.travelAllowance += slip.earnings?.travelAllowance || 0;
    ytd.earnings.medicalAllowance += slip.earnings?.medicalAllowance || 0;
    ytd.earnings.specialAllowance += slip.earnings?.specialAllowance || 0;
    ytd.earnings.overtime += slip.earnings?.overtime || 0;
    ytd.earnings.bonus += slip.earnings?.bonus || 0;
    ytd.earnings.arrears += slip.earnings?.arrears || 0;
    
    ytd.deductions.pf += slip.deductions?.pf || 0;
    ytd.deductions.esi += slip.deductions?.esi || 0;
    ytd.deductions.tds += slip.deductions?.tds || 0;
    ytd.deductions.professionalTax += slip.deductions?.professionalTax || 0;
    ytd.deductions.lop += slip.deductions?.lop || 0;
  });
  
  // Add current month
  ytd.earnings.basic += parseFloat(basic.toFixed(2));
  ytd.earnings.hra += parseFloat(hra.toFixed(2));
  ytd.earnings.travelAllowance += parseFloat(travel.toFixed(2));
  ytd.earnings.medicalAllowance += parseFloat(medical.toFixed(2));
  ytd.earnings.specialAllowance += parseFloat(special.toFixed(2));
  ytd.earnings.overtime += overtimePay;
  ytd.earnings.totalEarnings = Object.values(ytd.earnings).reduce((a, b) => a + b, 0);
  
  ytd.deductions.pf += pfEmployee;
  ytd.deductions.esi += esiEmployee;
  ytd.deductions.tds += tds;
  ytd.deductions.professionalTax += professionalTax;
  ytd.deductions.lop += lopDeduction;
  ytd.deductions.totalDeductions = Object.values(ytd.deductions).reduce((a, b) => a + b, 0);

  return {
    earnings: {
      basic:            parseFloat(basic.toFixed(2)),
      hra:              parseFloat(hra.toFixed(2)),
      travelAllowance:  parseFloat(travel.toFixed(2)),
      medicalAllowance: parseFloat(medical.toFixed(2)),
      specialAllowance: parseFloat(special.toFixed(2)),
      overtime:         overtimePay,
      bonus:            0,
      arrears:          0,
    },
    deductions: {
      pf:              pfEmployee,
      esi:             esiEmployee,
      tds,
      lop:             lopDeduction,
      professionalTax,
      advance:         0,
      other:           0,
    },
    grossSalary:       parseFloat(grossBeforeLOP.toFixed(2)),
    grossAfterLOP:      parseFloat(grossSalary.toFixed(2)),     //
    netSalary:         Math.max(0, netSalary),
    actualPayableDays: eligibility.actualPayableDays,
    eligibleCalendarDays: eligibility.eligibleCalendarDays,
    totalWorkingDays,
    eligibleWorkingDays,
    daysPresent:       parseFloat(daysPresent.toFixed(1)),
    lopDays:           parseFloat(lopDays.toFixed(2)),
    daysPayable:       parseFloat(daysPayable.toFixed(2)),
    overtimeHours:     parseFloat((att.overtimeHours || 0).toFixed(2)),
    
    // LOP calculation details for payslip display
    lopPerDayRate:     parseFloat((isHourlyLOP ? hourlyRate * standardHours : dailySalary).toFixed(2)),
    lopFormulaUsed:    formulaUsed,
    lopFormulaDays:    lopDivisorDays,
    
    // Overtime calculation details
    overtimeRate:      parseFloat(overtimeRate.toFixed(2)),
    overtimeMultiplier: overtimeMultiplier,
    
    // Employer contributions
    employerContributions: {
      pf:    pfEmployer,
      esi:   esiEmployer,
      gratuity: policy?.taxCompliance?.gratuityEnabled ? parseFloat((basic * ((policy?.taxCompliance?.gratuityRate ?? 4.81) / 100)).toFixed(2)) : 0
    },
    
    // Tax information
    taxRegime: policy?.tdsConfig?.taxRegime || 'new',
    taxBreakdown: taxBreakdown ? {
      taxableIncome: taxBreakdown.taxableIncome,
      grossTax: taxBreakdown.grossTax,
      rebate87A: taxBreakdown.rebate87A,
      surcharge: taxBreakdown.surcharge,
      cess: taxBreakdown.cess,
      totalTax: taxBreakdown.totalTax,
    } : null,
    
    // Year-to-Date
    ytd: {
      earnings: ytd.earnings,
      deductions: ytd.deductions
    }
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// RUN FOR SINGLE EMPLOYEE
// ─────────────────────────────────────────────────────────────────────────────

exports.runForEmployee = async (employeeId, company_id, unit_id, month, user) => {
  const { year, month: mon, start, end } = parseMonth(month);

  const employeeFilter = {
    _id:        employeeId,
    org_id:     user.orgId,
    company_id,
    isDeleted:  false,
    $and: [
      { $or: [{ joiningDate: { $exists: false } }, { joiningDate: null }, { joiningDate: { $lte: end } }] },
      { $or: [{ exitDate: { $exists: false } }, { exitDate: null }, { exitDate: { $gte: start } }] },
      { $or: [{ status: { $ne: "TERMINATED" } }, { exitDate: { $gte: start, $lte: end } }] },
    ],
  };
  if (unit_id) employeeFilter.unit_id = unit_id;

  const employee = await Employee.findOne(employeeFilter);
  if (!employee) throw new AppError("Employee not found", 404);

  const existing = await Payslip.findOne({
    org_id: user.orgId,
    company_id,
    employee_id: employee._id,
    year,
    month: mon,
  }).select("status").lean();
  assertPayslipCanBeRecalculated(existing?.status);

  // ── MANDATORY: Payroll policy must exist ───────────────────
  let policy;
  try {
    policy = await resolvePayrollPolicy(employee._id.toString(), company_id, unit_id, { fresh: true });
  } catch (policyErr) {
    throw new AppError(
      `No active payroll policy found for employee. Please create and activate a payroll policy before running payroll.`,
      400
    );
  }
  if (!policy) {
    throw new AppError(
      `No active payroll policy found for employee. Please create and activate a payroll policy before running payroll.`,
      400
    );
  }
  assertPayrollRunDateReached(year, mon, policy.salaryCycle?.payrollRunDate);

  const isLocked = await lockService.isPeriodLocked(mon, year, user.orgId, unit_id, company_id);
  if (!isLocked) {
    throw new AppError("Payroll period must be locked before payroll can be run", 423);
  }
  const effectiveUnitId = employee.unit_id || unit_id;
  const [config, company, unit] = await Promise.all([
    CompanyConfig.findOne({ company_id }).lean(),
    Company.findOne({ _id: company_id, org_id: user.orgId }).select("pt_state").lean(),
    effectiveUnitId
      ? Unit.findOne({ _id: effectiveUnitId, company_id }).select("geolocation.address.stateCode").lean()
      : null,
  ]);

  const calc = await calculateForEmployee(employee, company_id, effectiveUnitId, year, mon, policy, config, {
    companyState: company?.pt_state,
    unitState: unit?.geolocation?.address?.stateCode,
  });

  const payslip = await Payslip.findOneAndUpdate(
    { employee_id: employee._id, year, month: mon },
    {
      org_id:     employee.org_id,
      company_id,
      unit_id:    employee.unit_id || unit_id,
      employee_id: employee._id,
      year,
      month:      mon,
      ...calc,
      status: "DRAFT",
    },
    { upsert: true, new: true }
  );

  return payslip;
};

// ─────────────────────────────────────────────────────────────────────────────
// RUN FOR ALL EMPLOYEES (Batch)
// ─────────────────────────────────────────────────────────────────────────────

exports.runForTenant = async (company_id, unit_id, month, createdBy, user) => {
  const { year, month: mon, start, end } = parseMonth(month);

  const isLocked = await lockService.isPeriodLocked(mon, year, user.orgId, unit_id, company_id);
  if (!isLocked) throw new AppError("Payroll period must be locked before payroll can be run", 423);

  const filter = {
    org_id: user.orgId,
    company_id,
    isDeleted: false,
    $and: [
      { $or: [{ joiningDate: { $exists: false } }, { joiningDate: null }, { joiningDate: { $lte: end } }] },
      { $or: [{ exitDate: { $exists: false } }, { exitDate: null }, { exitDate: { $gte: start } }] },
      { $or: [{ status: { $ne: "TERMINATED" } }, { exitDate: { $gte: start, $lte: end } }] },
    ],
  };
  if (unit_id) filter.unit_id = unit_id;

  const employees = await Employee.find(filter).lean();

  const protectedPayslips = await Payslip.find({
    org_id: user.orgId,
    company_id,
    employee_id: { $in: employees.map(employee => employee._id) },
    year,
    month: mon,
    status: { $in: ["PUBLISHED", "PAID"] },
  }).select("employee_id status").lean();
  const protectedStatusByEmployee = new Map(
    protectedPayslips.map(payslip => [payslip.employee_id.toString(), payslip.status])
  );
  
  if (!employees.length) throw new AppError("No active employees found", 404);

  const employeeUnitIds = [...new Set(employees.map(employee => employee.unit_id?.toString()).filter(Boolean))];
  const [config, company, units] = await Promise.all([
    CompanyConfig.findOne({ company_id }).lean(),
    Company.findOne({ _id: company_id, org_id: user.orgId }).select("pt_state").lean(),
    Unit.find({ _id: { $in: employeeUnitIds }, company_id }).select("geolocation.address.stateCode").lean(),
  ]);
  const unitStateById = new Map(
    units.map(unit => [unit._id.toString(), unit.geolocation?.address?.stateCode])
  );

  const results = { processed: 0, failed: 0, errors: [] };

  for (const employee of employees) {
    try {
      assertPayslipCanBeRecalculated(protectedStatusByEmployee.get(employee._id.toString()));
      
      // ── MANDATORY: Payroll policy must exist ─────────────────
      let policy;
      try {
        policy = await resolvePayrollPolicy(
          employee._id.toString(), company_id,
          employee.unit_id?.toString() || unit_id, { fresh: true }
        );
      } catch (policyErr) {
        results.failed++;
        results.errors.push({
          employeeId: employee._id,
          name: employee.name,
          error: "No active payroll policy found. Please create and activate a payroll policy."
        });
        continue; // Skip this employee, process others
      }
      if (!policy) {
        results.failed++;
        results.errors.push({
          employeeId: employee._id,
          name: employee.name,
          error: "No active payroll policy found. Please create and activate a payroll policy."
        });
        continue;
      }
      assertPayrollRunDateReached(year, mon, policy.salaryCycle?.payrollRunDate);
      // ── CALCULATE PAYSLIP ─────────────────────────────────────────
      
      let calc;
      try {
        calc = await calculateForEmployee(
          employee, company_id,
          employee.unit_id || unit_id,
          year, mon, policy, config,
          {
            companyState: company?.pt_state,
            unitState: unitStateById.get((employee.unit_id || unit_id)?.toString()),
          }
        );
      } catch (calcErr) {
        throw calcErr;
      }

      // ── SAVE/UPDATE PAYSLIP ───────────────────────────────────────────
      try {
        const filter = { employee_id: employee._id, year, month: mon };
        const update = {
          org_id:      employee.org_id,
          company_id,
          unit_id:     employee.unit_id || unit_id,
          employee_id: employee._id,
          year,
          month:       mon,
          ...calc,
          status:      "DRAFT",
          generatedBy: createdBy,
        };
        
        const payslip = await Payslip.findOneAndUpdate(
          filter,
          update,
          { upsert: true, new: true }
        );
        results.processed++;
      } catch (saveErr) {
        throw saveErr;
      }
    } catch (err) {
      results.failed++;
      results.errors.push({ 
        employeeId: employee._id, 
        name: employee.name, 
        error: err.message
      });
    }
  }

  return {
    month,
    summary: results,
    message: `Payroll run complete. Processed: ${results.processed}, Failed: ${results.failed}`,
  };
};