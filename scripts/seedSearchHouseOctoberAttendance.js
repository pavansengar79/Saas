"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Organization = require("../modules/organisation/models/organization.model");
const Unit = require("../modules/unit/models/unit.model");
const Employee = require("../modules/employee/models/employee.model");
const Attendance = require("../modules/attendance/models/attendance.model");
const LeaveRequest = require("../modules/leave/models/leaveRequest.models");
const Holiday = require("../modules/holiday/models/holiday.models");
const CompanyConfig = require("../modules/companyConfig/models/companyConfig.model");
const PayrollPeriodLock = require("../modules/payrollPolicy/models/payrollPeriodLock.model");

const MONTH = "2026-10";
const APPLY = process.argv.includes("--apply");
const ALLOW_LOCKED = process.argv.includes("--allow-locked");
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

async function seedAttendance() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);

  const organization = await Organization.findOne({
    slug: "the-search-house",
    created_by: "INTERNAL_TEST_SEED",
  }).lean();
  if (!organization) throw new Error("Internal Search House test organization not found");

  const unit = await Unit.findOne({ org_id: organization._id, name: "Beno Technology", is_deleted: false }).lean();
  if (!unit) throw new Error("Beno Technology test unit not found");

  const config = await CompanyConfig.findOne({ org_id: organization._id, company_id: unit.company_id }).lean();
  const timezone = config?.timezone || organization.timezone || "Asia/Kolkata";
  const workWeek = config?.workWeek || ["MON", "TUE", "WED", "THU", "FRI"];
  const start = moment.tz(`${MONTH}-01`, "YYYY-MM-DD", timezone);
  const end = start.clone().date(17);
  const employees = await Employee.find({
    org_id: organization._id,
    company_id: unit.company_id,
    unit_id: unit._id,
    employeeId: /^TSH-BT-0(0[1-9]|1[0-3])$/,
    email: /@the-search-house\.example\.com$/,
    isDeleted: false,
  }).select("_id userId employeeId name joiningDate exitDate").lean();
  if (employees.length !== 13 || employees.some(employee => !employee.userId)) {
    throw new Error(`Expected 13 seeded employees with user accounts, found ${employees.length}`);
  }

  const scope = { org_id: organization._id, company_id: unit.company_id, unit_id: unit._id };
  const [locks, existing, leaves, holidays] = await Promise.all([
    PayrollPeriodLock.find({
      org_id: scope.org_id, company_id: scope.company_id, unit_id: { $in: [unit._id, null] },
      month: 10, year: 2026, isLocked: true,
    }).lean(),
    Attendance.find({ ...scope, employeeId: { $in: employees.map(employee => employee._id) }, date: { $gte: start.toDate(), $lt: end.toDate() } })
      .select("employeeId date").lean(),
    LeaveRequest.find({ ...scope, employeeId: { $in: employees.map(employee => employee._id) },
      status: "APPROVED", isDeleted: false, startDate: { $lt: end.toDate() }, endDate: { $gte: start.toDate() },
    }).select("employeeId startDate endDate").lean(),
    Holiday.find({ org_id: scope.org_id, company_id: scope.company_id, isDeleted: false,
      date: { $gte: start.toDate(), $lt: end.toDate() },
    }).select("date").lean(),
  ]);

  const occupied = new Set(existing.map(record => `${record.employeeId}:${moment(record.date).tz(timezone).format("YYYY-MM-DD")}`));
  const holidayDays = new Set(holidays.map(holiday => moment(holiday.date).tz(timezone).format("YYYY-MM-DD")));
  const records = [];

  for (const employee of employees) {
    for (const day = start.clone(); day.isBefore(end); day.add(1, "day")) {
      const dateKey = day.format("YYYY-MM-DD");
      if (!workWeek.includes(DAY_NAMES[day.day()]) || holidayDays.has(dateKey)) continue;
      if (employee.joiningDate && day.isBefore(moment(employee.joiningDate).tz(timezone), "day")) continue;
      if (employee.exitDate && day.isAfter(moment(employee.exitDate).tz(timezone), "day")) continue;
      if (occupied.has(`${employee._id}:${dateKey}`)) continue;
      if (leaves.some(leave => String(leave.employeeId) === String(employee._id)
        && day.isBetween(moment(leave.startDate).tz(timezone), moment(leave.endDate).tz(timezone), "day", "[]"))) continue;

      const variant = crypto.createHash("sha256").update(`${employee.employeeId}:${dateKey}`).digest()[0] % 20;
      const status = variant < 13 ? "PRESENT" : variant < 16 ? "LATE" : variant < 19 ? "HALF_DAY" : "ABSENT";
      const lateMinutes = status === "LATE" ? 20 + variant % 4 * 10 : 0;
      const checkIn = status === "ABSENT" ? null : day.clone().hour(status === "LATE" ? 9 : 8).minute(status === "LATE" ? lateMinutes : variant % 4 * 10).toDate();
      const hours = status === "HALF_DAY" ? 4 : 8;
      records.push({
        ...scope, employeeId: employee._id, userId: employee.userId, date: day.toDate(),
        status, checkIn, checkOut: checkIn ? new Date(checkIn.getTime() + hours * 60 * 60 * 1000) : null,
        workingHours: checkIn ? hours : 0, isLate: status === "LATE", lateMinutes, punchSource: "MANUAL",
        remarks: "Synthetic attendance for internal payroll testing",
      });
    }
  }

  console.log(JSON.stringify({ from: `${MONTH}-01`, through: `${MONTH}-16`, unit: unit.name, employees: employees.length,
    existing: existing.length, planned: records.length, locked: locks.length > 0, mode: APPLY ? "apply" : "dry-run",
    statuses: records.reduce((counts, record) => ({ ...counts, [record.status]: (counts[record.status] || 0) + 1 }), {}),
  }, null, 2));

  if (!APPLY) return;
  if (locks.length && !ALLOW_LOCKED) throw new Error("October payroll is locked. Pass --allow-locked explicitly to seed this test organization without changing its lock.");

  let inserted = 0;
  for (const record of records) {
    const result = await Attendance.updateOne(
      { ...scope, employeeId: record.employeeId, date: record.date },
      { $setOnInsert: record },
      { upsert: true, runValidators: true }
    );
    inserted += result.upsertedCount;
  }
  console.log(`Inserted ${inserted} attendance records; existing records were left unchanged.`);
}

seedAttendance().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());