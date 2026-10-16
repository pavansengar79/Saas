// modules/shift/roster.service.js
//
// Roster = assign an employee to a shift for a date range
//
// Dynamic design:
//   - Overlap check: an employee cannot have two active rosters at the same time
//   - Bulk assign: assign multiple employees to one shift at once
//   - Calendar view: see employees' shifts by month
//   - Revoke: manually cancel before endDate
//   - HR Manager can create/revoke; employees can only view
//   - resolveShiftForEmployee is already handled by shift.service.js
//     (attendance.service.js uses that function, not this one)

"use strict";

const Roster   = require("./models/roster.model");
const Shift    = require("./models/shift.model");
const Employee = require("../employee/models/employee.model");
const AppError = require("../../utils/appError");
const mongoose = require("mongoose");

const toObjId = (id) => new mongoose.Types.ObjectId(String(id));

// ─── Helper: normalize date to midnight UTC ───────────────────
const toMidnight = (d) => {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  return date;
};

// ─── Helper: format date for display ─────────────────────────
const fmtDate = (d) => {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

// ─── Helper: scope filter ────────────────────────────────────
const buildScope = (user, unitOverride = null) => ({
  org_id:     toObjId(user.orgId),
  company_id: toObjId(user.companyId),
  unit_id:    toObjId(unitOverride || user.unitId),
  is_deleted: false,
});

// ─── Helper: overlap check for one employee ───────────────────
// Check whether another ACTIVE roster already exists for this employee
// within the given date range
const checkOverlap = async (employeeId, unitId, startDate, endDate, excludeId = null) => {
  const query = {
    employee_id: toObjId(employeeId),
    unit_id:     toObjId(unitId),
    status:      "ACTIVE",
    is_deleted:  false,
    // Overlap condition: existing.startDate <= newEndDate AND existing.endDate >= newStartDate
    startDate:   { $lte: toMidnight(endDate) },
    endDate:     { $gte: toMidnight(startDate) },
  };
  if (excludeId) query._id = { $ne: toObjId(excludeId) };

  const overlap = await Roster.findOne(query)
    .populate("shift_id", "name")
    .lean();

  if (overlap) {
    throw new AppError(
      `Employee already has an active roster "${overlap.shift_id?.name || ""}" ` +
      `from ${fmtDate(overlap.startDate)} to ${fmtDate(overlap.endDate)} ` +
      `that overlaps with the selected date range. ` +
      `Please revoke the existing roster first or choose non-overlapping dates.`,
      409
    );
  }
};

// ─── CREATE (single employee) ────────────────────────────────
// POST /rosters
// Body: { employee_id, shift_id, startDate, endDate, notes, unit_id? }
exports.createRoster = async (payload, user) => {
  const {
    employee_id,
    shift_id,
    startDate,
    endDate,
    notes   = "",
    unit_id,
  } = payload;

  const targetUnitId = unit_id || user.unitId;
  if (!targetUnitId) throw new AppError("unit_id is required", 400);

  // Date validation
  const start = toMidnight(startDate);
  const end   = toMidnight(endDate);
  if (isNaN(start.getTime())) throw new AppError("Invalid startDate", 400);
  if (isNaN(end.getTime()))   throw new AppError("Invalid endDate", 400);
  if (end < start)            throw new AppError("endDate must be on or after startDate", 400);

  // Shift exists + belongs to same unit/company/org
  const shift = await Shift.findOne({
    _id:        toObjId(shift_id),
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    unit_id:    toObjId(targetUnitId),
    status:     "ACTIVE",
    is_deleted: false,
  }).lean();
  if (!shift) throw new AppError("Shift not found or inactive in this unit", 404);

  // Employee exists + belongs to scope
  const employee = await Employee.findOne({
    _id:        toObjId(employee_id),
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    unit_id:    toObjId(targetUnitId),
    isDeleted:  false,
    status:     "ACTIVE",
  }).lean();
  if (!employee) throw new AppError("Employee not found or inactive in this unit", 404);

  // Overlap check
  await checkOverlap(employee_id, targetUnitId, start, end);

  const roster = await Roster.create({
    org_id:      user.orgId,
    company_id:  user.companyId,
    unit_id:     targetUnitId,
    employee_id: toObjId(employee_id),
    shift_id:    toObjId(shift_id),
    startDate:   start,
    endDate:     end,
    notes,
    status:      "ACTIVE",
    createdBy:   user.userId,
  });

  return await Roster.findById(roster._id)
    .populate({
      path: "shift_id",
      select: "name startTime endTime shiftType isDefault"
    })
    .populate({
      path: "employee_id",
      select: "name employeeId email phone",
      model: "Employee"
    })
    .populate({
      path: "createdBy",
      select: "name email"
    })
    .lean();
};

// ─── BULK ASSIGN ─────────────────────────────────────────────
// POST /rosters/bulk
// Assign multiple employees to one shift at once
// Body: { employee_ids: [], shift_id, startDate, endDate, notes, unit_id? }
exports.bulkAssignRoster = async (payload, user) => {
  const {
    employee_ids,
    shift_id,
    startDate,
    endDate,
    notes      = "",
    unit_id,
  } = payload;

  if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
    throw new AppError("employee_ids must be a non-empty array", 400);
  }
  if (employee_ids.length > 100) {
    throw new AppError("Cannot assign more than 100 employees at once", 400);
  }

  const targetUnitId = unit_id || user.unitId;
  if (!targetUnitId) throw new AppError("unit_id is required", 400);

  const start = toMidnight(startDate);
  const end   = toMidnight(endDate);
  if (isNaN(start.getTime())) throw new AppError("Invalid startDate", 400);
  if (isNaN(end.getTime()))   throw new AppError("Invalid endDate", 400);
  if (end < start)            throw new AppError("endDate must be on or after startDate", 400);

  // Shift validate
  const shift = await Shift.findOne({
    _id:        toObjId(shift_id),
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    unit_id:    toObjId(targetUnitId),
    status:     "ACTIVE",
    is_deleted: false,
  }).lean();
  if (!shift) throw new AppError("Shift not found or inactive in this unit", 404);

  // Process each employee — collect successes and failures separately
  const results  = { success: [], failed: [] };

  for (const empId of employee_ids) {
    try {
      // Employee validate
      const employee = await Employee.findOne({
        _id:        toObjId(empId),
        org_id:     toObjId(user.orgId),
        company_id: toObjId(user.companyId),
        unit_id:    toObjId(targetUnitId),
        isDeleted:  false,
        status:     "ACTIVE",
      }).select("name employeeId").lean();

      if (!employee) {
        results.failed.push({ employee_id: empId, reason: "Employee not found or inactive" });
        continue;
      }

      // Overlap check
      await checkOverlap(empId, targetUnitId, start, end);

      await Roster.create({
        org_id:      user.orgId,
        company_id:  user.companyId,
        unit_id:     targetUnitId,
        employee_id: toObjId(empId),
        shift_id:    toObjId(shift_id),
        startDate:   start,
        endDate:     end,
        notes,
        status:      "ACTIVE",
        createdBy:   user.userId,
      });

      results.success.push({
        employee_id:  empId,
        employeeCode: employee.employeeId,
        name:         employee.name,
      });
    } catch (err) {
      results.failed.push({
        employee_id: empId,
        reason:      err.message,
      });
    }
  }

  return {
    shift:        { id: shift._id, name: shift.name },
    dateRange:    { startDate: fmtDate(start), endDate: fmtDate(end) },
    totalRequested: employee_ids.length,
    assigned:     results.success.length,
    failed:       results.failed.length,
    results,
  };
};

// ─── GET EMPLOYEE ROSTERS ─────────────────────────────────────
// GET /rosters?employee_id=&month=YYYY-MM&status=&unit_id=
// Employees can view their own rosters; HR can view all rosters
exports.getEmployeeRosters = async (query, user) => {
  const {
    employee_id,
    month,      // "YYYY-MM" — filter by month overlap
    status,
    unit_id,
    page  = 1,
    limit = 20,
  } = query;

  // Employees can view only their own rosters
  const targetEmployeeId = user.roleSlug === "employee"
    ? user.employeeId
    : employee_id;

  const filter = {
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    is_deleted: false,
  };

  if (unit_id || user.unitId) {
    filter.unit_id = toObjId(unit_id || user.unitId);
  }
  if (targetEmployeeId) filter.employee_id = toObjId(targetEmployeeId);
  if (status)           filter.status      = status;

  // Month filter — rosters that overlap with the given month
  if (month) {
    const [yr, mo]   = month.split("-").map(Number);
    const monthStart = new Date(yr, mo - 1, 1);
    const monthEnd   = new Date(yr, mo, 0); // last day of month
    monthEnd.setHours(23, 59, 59, 999);

    filter.startDate = { $lte: monthEnd };
    filter.endDate   = { $gte: monthStart };
  }

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await Roster.countDocuments(filter);

  const rosters = await Roster.find(filter)
    .sort({ startDate: -1 })
    .skip(skip)
    .limit(Number(limit))
    .populate({
      path: "shift_id",
      select: "name startTime endTime shiftType gracePeriodMinutes workingMinutes isDefault"
    })
    .populate({
      path: "employee_id",
      select: "name employeeId email phone departmentId",
      model: "Employee"
    })
    .populate({
      path: "createdBy",
      select: "name email"
    })
    .lean();

  return {
    rosters,
    total,
    page:       Number(page),
    totalPages: Math.ceil(total / Number(limit)),
  };
};

// ─── CALENDAR VIEW ────────────────────────────────────────────
// GET /rosters/calendar?month=YYYY-MM&unit_id=&department_id=
// HR + Manager: see who is on which shift this month in a visual calendar
exports.getRosterCalendar = async (query, user) => {
  const { month, unit_id, department_id } = query;

  if (!month) throw new AppError("month is required (format: YYYY-MM)", 400);

  const [yr, mo]   = month.split("-").map(Number);
  if (!yr || !mo || mo < 1 || mo > 12) throw new AppError("Invalid month format. Use YYYY-MM", 400);

  const monthStart = new Date(yr, mo - 1, 1);
  const monthEnd   = new Date(yr, mo, 0);
  monthEnd.setHours(23, 59, 59, 999);

  const targetUnitId = unit_id || user.unitId;

  // Find all active rosters overlapping this month
  const rosterFilter = {
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    status:     "ACTIVE",
    is_deleted: false,
    startDate:  { $lte: monthEnd },
    endDate:    { $gte: monthStart },
  };
  if (targetUnitId) rosterFilter.unit_id = toObjId(targetUnitId);

  const rosters = await Roster.find(rosterFilter)
    .populate({
      path:   "employee_id",
      select: "name employeeId departmentId email phone",
      model:  "Employee",
      match:  department_id
        ? { departmentId: toObjId(department_id), isDeleted: false }
        : { isDeleted: false },
    })
    .populate({
      path:   "shift_id",
      select: "name startTime endTime shiftType"
    })
    .lean();

  // Filter out rosters where employee populate returned null (dept filter)
  const validRosters = rosters.filter((r) => r.employee_id !== null);

  // Build calendar structure:
  // {
  //   month: "2026-06",
  //   daysInMonth: 30,
  //   employees: [
  //     {
  //       employee: { id, name, employeeId },
  //       assignments: [
  //         { startDate, endDate, shift: { name, startTime, endTime } }
  //       ],
  //       // For frontend grid: which dates are covered
  //       coveredDates: ["2026-06-01", "2026-06-02", ...]
  //     }
  //   ],
  //   shifts: [unique shift list for legend]
  // }

  const daysInMonth  = new Date(yr, mo, 0).getDate();
  const employeeMap  = new Map();
  const shiftSet     = new Map();

  for (const roster of validRosters) {
    const empId   = roster.employee_id._id.toString();
    const shift   = roster.shift_id;

    if (!employeeMap.has(empId)) {
      employeeMap.set(empId, {
        employee:    {
          id:         roster.employee_id._id,
          name:       roster.employee_id.name,
          employeeId: roster.employee_id.employeeId,
        },
        assignments: [],
        coveredDates: [],
      });
    }

    const entry = employeeMap.get(empId);

    // Add assignment
    entry.assignments.push({
      roster_id: roster._id,
      startDate: roster.startDate,
      endDate:   roster.endDate,
      shift: shift
        ? { id: shift._id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime, shiftType: shift.shiftType }
        : null,
    });

    // Build coveredDates within this month
    const rangeStart = new Date(Math.max(roster.startDate, monthStart));
    const rangeEnd   = new Date(Math.min(roster.endDate, monthEnd));
    const cur        = new Date(rangeStart);
    while (cur <= rangeEnd) {
      const dateStr = cur.toISOString().split("T")[0]; // "YYYY-MM-DD"
      if (!entry.coveredDates.includes(dateStr)) {
        entry.coveredDates.push(dateStr);
      }
      cur.setDate(cur.getDate() + 1);
    }

    // Shift legend
    if (shift && !shiftSet.has(shift._id.toString())) {
      shiftSet.set(shift._id.toString(), {
        id:        shift._id,
        name:      shift.name,
        startTime: shift.startTime,
        endTime:   shift.endTime,
        shiftType: shift.shiftType,
      });
    }
  }

  return {
    month,
    daysInMonth,
    employees: Array.from(employeeMap.values()),
    shifts:    Array.from(shiftSet.values()),   // for legend/color coding
    totalEmployees: employeeMap.size,
  };
};

// ─── GET BY ID ───────────────────────────────────────────────
exports.getRosterById = async (id, user) => {
  const roster = await Roster.findOne({
    _id:        toObjId(id),
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    is_deleted: false,
  })
    .populate({ path: "shift_id", select: "name startTime endTime shiftType gracePeriodMinutes workingMinutes isDefault" })
    .populate({ path: "employee_id", select: "name employeeId departmentId designationId email", model: "Employee" })
    .populate({ path: "createdBy", select: "name email" })
    .lean();

  if (!roster) throw new AppError("Roster not found", 404);
  return roster;
};

// ─── UPDATE ──────────────────────────────────────────────────
// PUT /rosters/:id
// Can change: shift_id, startDate, endDate, notes
// Cannot change: employee_id, unit_id (create new instead)
exports.updateRoster = async (id, payload, user) => {
  const roster = await Roster.findOne({
    _id:        toObjId(id),
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    is_deleted: false,
  });
  if (!roster)                 throw new AppError("Roster not found", 404);
  if (roster.status === "REVOKED") throw new AppError("Cannot update a revoked roster", 400);

  const { shift_id, startDate, endDate, notes } = payload;

  const newStart = startDate ? toMidnight(startDate) : roster.startDate;
  const newEnd   = endDate   ? toMidnight(endDate)   : roster.endDate;

  if (newEnd < newStart) throw new AppError("endDate must be on or after startDate", 400);

  // Shift validate if changed
  if (shift_id && shift_id.toString() !== roster.shift_id.toString()) {
    const shift = await Shift.findOne({
      _id:        toObjId(shift_id),
      org_id:     toObjId(user.orgId),
      company_id: toObjId(user.companyId),
      unit_id:    roster.unit_id,
      status:     "ACTIVE",
      is_deleted: false,
    }).lean();
    if (!shift) throw new AppError("Shift not found or inactive in this unit", 404);
    roster.shift_id = toObjId(shift_id);
  }

  // Overlap check (excluding self)
  await checkOverlap(roster.employee_id, roster.unit_id, newStart, newEnd, id);

  if (startDate) roster.startDate = newStart;
  if (endDate)   roster.endDate   = newEnd;
  if (notes !== undefined) roster.notes = notes;

  roster.updatedBy = user.userId;
  await roster.save();

  return await Roster.findById(roster._id)
    .populate({ path: "shift_id", select: "name startTime endTime shiftType" })
    .populate({ path: "employee_id", select: "name employeeId email phone", model: "Employee" })
    .lean();
};

// ─── REVOKE ──────────────────────────────────────────────────
// PATCH /rosters/:id/revoke
// Manually cancel before endDate
// Body: { reason? }
exports.revokeRoster = async (id, payload, user) => {
  const roster = await Roster.findOne({
    _id:        toObjId(id),
    org_id:     toObjId(user.orgId),
    company_id: toObjId(user.companyId),
    is_deleted: false,
  });
  if (!roster)                      throw new AppError("Roster not found", 404);
  if (roster.status === "REVOKED")  throw new AppError("Roster is already revoked", 400);
  if (roster.status === "ENDED")    throw new AppError("Roster has already ended", 400);

  roster.status     = "REVOKED";
  roster.revokedBy  = user.userId;
  roster.revokedAt  = new Date();
  roster.notes      = payload?.reason
    ? `${roster.notes ? roster.notes + " | " : ""}Revoked: ${payload.reason}`
    : roster.notes;
  roster.updatedBy  = user.userId;

  await roster.save();
  return { message: "Roster revoked successfully", roster_id: roster._id };
};