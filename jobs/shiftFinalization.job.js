// jobs/shiftFinalization.job.js
// Enterprise HRMS - Shift Finalization Cron Job
// 
// Purpose:
//   - Run after shift end + buffer period
//   - Calculate final working hours
//   - Finalize attendance for payroll processing
//   - Handle missed punch-outs (auto mark if policy allows)
//   - Calculate overtime based on policy
//
// Flow:
//   1. Get all active shifts that ended X minutes ago
//   2. For employees working those shifts:
//      a. If punched out → finalize working hours, calculate OT
//      b. If NOT punched out → 
//         - If policy allows auto punch-out → mark at shift end
//         - Else → flag for manager review
//   3. Update attendance records as 'finalized = true'
//   4. Payroll only uses finalized attendance data

"use strict";

const Attendance = require("../modules/attendance/models/attendance.model");
const Employee = require("../modules/employee/models/employee.model");
const Shift = require("../modules/shift/models/shift.model");
const CompanyConfig = require("../modules/companyConfig/models/companyConfig.model");
const moment = require('moment-timezone');
const {
  calculateWorkingHours,
  calculateOvertime,
  getTodayDateInOrgTimezone,
  formatInTimezone,
  formatTimeOnly
} = require('../utils/timezone');

/**
 * Run shift finalization for all organizations
 * Called by cron scheduler every hour
 * 
 * @param {Number} bufferMinutes - Minutes after shift end before finalization (default: 120)
 * @returns {Object} - Summary of processed records
 */
exports.runShiftFinalization = async (bufferMinutes = 120) => {
  console.log(`[ShiftFinalization] Starting shift finalization (buffer: ${bufferMinutes} min)`);
  
  try {
    const now = new Date();
    
    // Get all company configs with timezone
    const companyConfigs = await CompanyConfig.find({})
      .select('org_id company_id timezone overtimeEnabled overtimeThresholdHours autoPunchOutEnabled autoPunchOutMinutes')
      .lean();
    
    let processed = 0;
    let finalized = 0;
    let autoPunchedOut = 0;
    let flagged = 0;
    let errors = 0;
    
    for (const config of companyConfigs) {
      try {
        const timezone = config.timezone || 'Asia/Kolkata';
        const nowInOrg = moment(now).tz(timezone);
        
        // Find shifts that ended bufferMinutes ago
        const shifts = await Shift.find({
          org_id: config.org_id,
          company_id: config.company_id,
          isDeleted: false
        }).lean();
        
        for (const shift of shifts) {
          // Parse shift end time
          const [endH, endM] = shift.endTime.split(':').map(Number);
          const shiftEndTime = nowInOrg.clone().set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
          
          // Handle night shift (isNextDay)
          if (shift.isNextDay) {
            // The shift ending today started yesterday.
            // The attendance key therefore belongs to yesterday.
          }
          
          // Check if shift ended bufferMinutes ago
          const shiftEndWithBuffer = shiftEndTime.clone().add(bufferMinutes, 'minutes');
          const minutesAgo = nowInOrg.diff(shiftEndWithBuffer, 'minutes');
          
          // Format shift time for logging
          const formatShiftTimeForLog = (timeStr) => {
            if (!timeStr) return timeStr;
            const [h, m] = timeStr.split(':').map(Number);
            const period = h >= 12 ? 'PM' : 'AM';
            const displayHours = h % 12 || 12;
            return `${String(displayHours).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
          };
          
          // Process if shift ended (with buffer) between 0-60 minutes ago
          // This prevents reprocessing very old shifts
          if (minutesAgo >= 0 && minutesAgo < 60) {
            console.log(`[ShiftFinalization] Processing shift ${shift.name} (${formatShiftTimeForLog(shift.startTime)}-${formatShiftTimeForLog(shift.endTime)}) ended ${minutesAgo} min ago in ${timezone}`);
            
            // Find attendance records for this shift on this date
            const targetDate = getTodayDateInOrgTimezone(timezone);
            
            if (shift.isNextDay) {
              // For night shifts, look at yesterday's date
              const previousDay = moment(targetDate).tz(timezone).subtract(1, 'day').startOf('day').toDate();
              targetDate.setTime(previousDay.getTime());
            }
            
            const attendanceRecords = await Attendance.find({
              org_id: config.org_id,
              company_id: config.company_id,
              shiftId: shift._id,
              date: targetDate,
              finalized: { $ne: true } // Not already finalized
            }).lean();
            
            for (const record of attendanceRecords) {
              processed++;
              
              const result = await finalizeAttendanceRecord(record, shift, config, timezone, now);
              
              if (result.finalized) finalized++;
              if (result.autoPunchedOut) autoPunchedOut++;
              if (result.flagged) flagged++;
              if (result.error) errors++;
            }
          }
        }
        
      } catch (err) {
        console.error(`[ShiftFinalization] Error processing company ${config.company_id}:`, err.message);
        errors++;
      }
    }
    
    console.log(`[ShiftFinalization] Complete. Processed: ${processed}, Finalized: ${finalized}, Auto-PunchOut: ${autoPunchedOut}, Flagged: ${flagged}, Errors: ${errors}`);
    
    return {
      processed,
      finalized,
      autoPunchedOut,
      flagged,
      errors,
      timestamp: now
    };
    
  } catch (err) {
    console.error(`[ShiftFinalization] Critical error:`, err.message);
    throw err;
  }
};

/**
 * Finalize individual attendance record
 * 
 * @param {Object} record - Attendance record
 * @param {Object} shift - Shift details
 * @param {Object} config - CompanyConfig
 * @param {String} timezone - Organization timezone
 * @param {Date} now - Current timestamp
 * @returns {Object} - Result flags
 */
async function finalizeAttendanceRecord(record, shift, config, timezone, now) {
  const result = {
    finalized: false,
    autoPunchedOut: false,
    flagged: false,
    error: false
  };
  
  try {
    // Case 1: Already punched out → finalize working hours and OT
    if (record.checkOut) {
      // Checkout is the authority for worked intervals and policy-capped OT.
      // Recomputing first-to-last would incorrectly include breaks between sessions.
      const workingHours = record.workingHours ?? calculateWorkingHours(record.checkIn, record.checkOut, timezone);
      const overtimeHours = record.overtimeHours || 0;
      
      await Attendance.findByIdAndUpdate(record._id, {
        workingHours,
        overtimeHours,
        finalized: true,
        finalizedAt: now,
        finalizedBy: 'SYSTEM_CRON'
      });
      
      result.finalized = true;
      console.log(`[ShiftFinalization] Finalized record ${record._id}: ${workingHours}h work, ${overtimeHours}h OT`);
    }
    
    // Case 2: Not punched out
    else if (record.checkIn && !record.checkOut) {
      const autoPunchOutEnabled = config.autoPunchOutEnabled || false;
      const autoPunchOutMinutes = config.autoPunchOutMinutes || shift.endTime; // Default: shift end time
      
      if (autoPunchOutEnabled) {
        // Auto punch-out at shift end
        const [endH, endM] = shift.endTime.split(':').map(Number);
        const autoPunchOutTime = moment(record.date).tz(timezone)
          .set({ hour: endH, minute: endM, second: 0 });
        
        if (shift.isNextDay) {
          autoPunchOutTime.add(1, 'day');
        }
        
        const workingHours = calculateWorkingHours(record.checkIn, autoPunchOutTime.toDate(), timezone);
        
        await Attendance.findByIdAndUpdate(record._id, {
          checkOut: autoPunchOutTime.toDate(),
          workingHours,
          overtimeHours: 0, // No OT for auto punch-out
          finalized: true,
          finalizedAt: now,
          finalizedBy: 'SYSTEM_AUTO_PUNCHOUT',
          remarks: 'Auto punch-out by system (shift ended)'
        });
        
        result.finalized = true;
        result.autoPunchedOut = true;
        console.log(`[ShiftFinalization] Auto punch-out for record ${record._id} at ${formatInTimezone(autoPunchOutTime.toDate(), timezone, 'hh:mm A')}`);
      } else {
        // Flag for manager review
        await Attendance.findByIdAndUpdate(record._id, {
          needsReview: true,
          reviewReason: 'Missed punch-out after shift end',
          finalized: false,
          flaggedAt: now
        });
        
        result.flagged = true;
        console.log(`[ShiftFinalization] Flagged record ${record._id} for review (missed punch-out)`);
      }
    }
    
    // Case 3: No check-in (should not happen, but handle gracefully)
    else {
      console.warn(`[ShiftFinalization] Record ${record._id} has no check-in`);
      result.error = true;
    }
    
  } catch (err) {
    console.error(`[ShiftFinalization] Error finalizing record ${record._id}:`, err.message);
    result.error = true;
  }
  
  return result;
}

/**
 * Manual finalization endpoint (for admin)
 * POST /api/v1/admin/attendance/finalize
 * 
 * @param {Object} filters - { org_id, company_id, date, employeeId }
 * @returns {Object} - Finalization summary
 */
exports.manualFinalization = async (filters) => {
  console.log(`[ShiftFinalization] Manual finalization triggered for:`, filters);
  
  // Set bufferMinutes to 0 for manual override
  return await exports.runShiftFinalization(0);
};
