// jobs/autoAbsentMarker.job.js
// Runs every night at 11:55 PM
// Marks ABSENT for employees with no punch on working days
"use strict";

const Attendance = require("../modules/attendance/models/attendance.model");
const Employee   = require("../modules/employee/models/employee.model");
const CompanyConfig = require("../modules/companyConfig/models/companyConfig.model");
const Holiday = require('../modules/holiday/models/holiday.models');
const { getDayOfWeek, getTodayDateInOrgTimezone } = require('../utils/timezone');

exports.runAutoAbsentMarker = async () => {
  console.log(`[AutoAbsent] Running auto-absent marker...`);

  // Group employees by company to handle timezone per company
  const employees = await Employee.find({ status: "ACTIVE", isDeleted: false })
    .select("_id userId joiningDate org_id company_id unit_id").lean();

  let marked = 0;
  let skipped = 0;
  let errors = 0;

  // Group by company
  const companyGroups = {};
  for (const emp of employees) {
    const key = `${emp.org_id}_${emp.company_id}`;
    if (!companyGroups[key]) {
      companyGroups[key] = {
        org_id: emp.org_id,
        company_id: emp.company_id,
        employees: []
      };
    }
    companyGroups[key].employees.push(emp);
  }

  // Process each company with its timezone
  for (const [key, group] of Object.entries(companyGroups)) {
    try {
      // Fetch company config for timezone
      const config = await CompanyConfig.findOne({ 
        org_id: group.org_id, 
        company_id: group.company_id 
      }).select('timezone').lean();
      
      const timezone = config?.timezone || 'Asia/Kolkata';
      
      // Get target date in org timezone (yesterday)
      const todayInOrg = getTodayDateInOrgTimezone(timezone);
      const targetDate = require('moment-timezone')(todayInOrg).tz(timezone).subtract(1, 'day').startOf('day').toDate();
      
      console.log(`[AutoAbsent] Processing ${group.employees.length} employees for ${targetDate.toDateString()} in ${timezone}`);
      
      // Check if working day in org timezone
      const dayOfWeek = getDayOfWeek(targetDate, timezone);
      const isWorkingDay = ["MON","TUE","WED","THU","FRI"].includes(dayOfWeek);
      
      if (!isWorkingDay) {
        console.log(`[AutoAbsent] ${key}: Skipping — non-working day (${dayOfWeek})`);
        skipped += group.employees.length;
        continue;
      }

      // Process each employee in this company
      for (const emp of group.employees) {
        try {
          if (!emp.userId || (emp.joiningDate && emp.joiningDate > targetDate)) { skipped++; continue; }
          const existing = await Attendance.findOne({ 
            org_id: emp.org_id,
            company_id: emp.company_id,
            employeeId: emp._id, 
            date: targetDate 
          });
          
          if (existing) { 
            skipped++; 
            continue; 
          }

          const holiday = await Holiday.findOne({ org_id: emp.org_id, company_id: emp.company_id,
            $or: [{ unit_id: emp.unit_id }, { unit_id: null }],
            date: { $gte: targetDate, $lt: todayInOrg }, isDeleted: false });
          if (holiday) { skipped++; continue; }

          // Check approved leave
          const LeaveRequest = require("../modules/leave/models/leaveRequest.models");
          const onLeave = await LeaveRequest.findOne({
            employeeId: emp._id,
            org_id: emp.org_id,
            company_id: emp.company_id,
            startDate: { $lte: targetDate },
            endDate:   { $gte: targetDate },
            status:    "APPROVED",
            isDeleted: false,
          });

          await Attendance.create({
            org_id:         emp.org_id,
            company_id:     emp.company_id,
            unit_id:        emp.unit_id,
            employeeId:     emp._id,
            userId:         emp.userId,
            date:           targetDate,
            status:         onLeave ? "ON_LEAVE" : "ABSENT",
            leaveRequestId: onLeave?._id || null,
            checkIn:        null,
            checkOut:       null,
            workingHours:   0,
            remarks:        onLeave ? "Auto-marked: On approved leave" : "Auto-marked: No punch recorded",
          });

          onLeave ? skipped++ : marked++;
        } catch (err) {
          console.error(`[AutoAbsent] Error emp ${emp._id}:`, err.message);
          errors++;
        }
      }
    } catch (err) {
      console.error(`[AutoAbsent] Error processing company ${key}:`, err.message);
      errors += group.employees.length;
    }
  }

  console.log(`[AutoAbsent] Done — Marked absent: ${marked}, Skipped: ${skipped}, Errors: ${errors}`);
  return { marked, skipped, errors };
};