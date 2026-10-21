// utils/timezone.js
// Enterprise HRMS Timezone Utility
// Handles timezone conversion for accurate attendance calculations across timezones

const moment = require('moment-timezone');

/**
 * Convert UTC date to organization timezone
 * @param {Date} utcDate - UTC timestamp
 * @param {String} timezone - IANA timezone (e.g., "Asia/Kolkata")
 * @returns {Date} - Date in org timezone
 */
const toOrgTimezone = (utcDate, timezone = 'Asia/Kolkata') => {
  return moment(utcDate).tz(timezone).toDate();
};

/**
 * Convert org timezone date to UTC
 * @param {Date} localDate - Date in org timezone
 * @param {String} timezone - IANA timezone
 * @returns {Date} - UTC timestamp
 */
const toUTC = (localDate, timezone = 'Asia/Kolkata') => {
  return moment.tz(localDate, timezone).utc().toDate();
};

/**
 * Get current time in org timezone
 * @param {String} timezone - IANA timezone
 * @returns {Date} - Current time in org timezone
 */
const nowInTimezone = (timezone = 'Asia/Kolkata') => {
  return moment().tz(timezone).toDate();
};

/**
 * Parse time string "HH:MM" to hours and minutes in org timezone
 * Create a date object for that time TODAY in org timezone
 * @param {String} timeStr - "HH:MM" format
 * @param {String} timezone - IANA timezone
 * @param {Date} referenceDate - Base date (default: today)
 * @returns {Date} - Date object with specified time in org timezone
 */
const createTimeInTimezone = (timeStr, timezone = 'Asia/Kolkata', referenceDate = null) => {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const baseDate = referenceDate ? moment(referenceDate).tz(timezone) : moment().tz(timezone);
  
  return baseDate.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 }).toDate();
};

/**
 * Get midnight (00:00:00) in org timezone for a given date
 * @param {Date} date - Any date
 * @param {String} timezone - IANA timezone
 * @returns {Date} - Midnight in org timezone
 */
const getMidnightInTimezone = (date, timezone = 'Asia/Kolkata') => {
  return moment(date).tz(timezone).startOf('day').toDate();
};

/**
 * Check if time is within shift window (timezone-aware)
 * @param {Date} punchTime - Actual punch time (UTC)
 * @param {String} shiftStart - "HH:MM" shift start time
 * @param {String} shiftEnd - "HH:MM" shift end time
 * @param {Boolean} isNextDay - True for night shifts crossing midnight
 * @param {Number} graceMinutes - Grace period
 * @param {String} timezone - Organization timezone
 * @param {Object} policy - Attendance policy settings
 * @returns {Object} - Validation result
 */
const validateShiftWindowTimezone = (punchTime, shiftStart, shiftEnd, isNextDay, graceMinutes, timezone = 'Asia/Kolkata', policy = {}) => {
  // Convert punch time to org timezone
  const punchInOrgTime = moment(punchTime).tz(timezone);
  const punchHour = punchInOrgTime.hour();
  const punchMinute = punchInOrgTime.minute();
  
  // Parse shift times
  const [startH, startM] = shiftStart.split(':').map(Number);
  const [endH, endM] = shiftEnd.split(':').map(Number);
  
  // ─── CRITICAL FIX: Determine which "day" the shift belongs to ───
  // For night shifts (isNextDay=true), handle cross-midnight scenario
  // 
  // Example: Shift 21:00 - 05:00
  // - If punch at 22:00 → Shift started TODAY at 21:00
  // - If punch at 02:00 → Shift started YESTERDAY at 21:00
  // - If punch at 19:00 → Too early, shift starts at 21:00 TODAY
  
  let shiftStartMoment;
  let shiftEndMoment;
  
  if (isNextDay) {
    // ─── NIGHT SHIFT LOGIC (Crosses Midnight) ───
    // Handle three scenarios:
    // 1. Evening BEFORE shift starts (e.g., 19:00 - too early)
    // 2. During first part (e.g., 22:00 - between start and midnight)
    // 3. During second part (e.g., 02:00 - after midnight, before shift ends)
    
    const timeAsMinutes = punchHour * 60 + punchMinute;
    const startAsMinutes = startH * 60 + startM;
    const endAsMinutes = endH * 60 + endM;
    
    if (timeAsMinutes >= startAsMinutes) {
      // Scenario 2: Punch time is in the first part of night shift (start to midnight)
      // Example: 21:00-23:59
      // Shift started TODAY at startH:startM, ends TOMORROW at endH:endM
      shiftStartMoment = punchInOrgTime.clone().startOf('day').set({ hour: startH, minute: startM, second: 0, millisecond: 0 });
      shiftEndMoment = punchInOrgTime.clone().startOf('day').set({ hour: endH, minute: endM, second: 0, millisecond: 0 }).add(1, 'day');
    } else if (timeAsMinutes < endAsMinutes) {
      // Scenario 3: Punch time is in the second part of night shift (after midnight)
      // Example: 00:00-04:59 for shift ending at 05:00
      // Shift started YESTERDAY at startH:startM, ends TODAY at endH:endM
      shiftStartMoment = punchInOrgTime.clone().subtract(1, 'day').startOf('day').set({ hour: startH, minute: startM, second: 0, millisecond: 0 });
      shiftEndMoment = punchInOrgTime.clone().startOf('day').set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
    } else {
      // Scenario 1: Too early - punch time is in the gap after previous shift ended
      // Example: 06:00-20:59 for shift starting at 21:00
      // Next shift starts TODAY at startH:startM
      shiftStartMoment = punchInOrgTime.clone().startOf('day').set({ hour: startH, minute: startM, second: 0, millisecond: 0 });
      shiftEndMoment = punchInOrgTime.clone().startOf('day').set({ hour: endH, minute: endM, second: 0, millisecond: 0 }).add(1, 'day');
    }
  } else {
    // Day shift (no midnight crossing)
    shiftStartMoment = punchInOrgTime.clone().startOf('day').set({ hour: startH, minute: startM, second: 0, millisecond: 0 });
    shiftEndMoment = punchInOrgTime.clone().startOf('day').set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
  }
  
  // Calculate window boundaries
  const allowEarlyMinutes = policy?.allowEarlyMinutes ?? 30;
  const windowOpen = shiftStartMoment.clone().subtract(allowEarlyMinutes, 'minutes');
  
  let windowClose = shiftEndMoment.clone();
  if (policy?.allowLatePunchIn && policy?.maxLateMinutes) {
    const extendedClose = shiftStartMoment.clone().add(graceMinutes + policy.maxLateMinutes, 'minutes');
    windowClose = moment.max(windowClose, extendedClose);
  }
  
  const strictWindow = policy?.strictPunchWindow !== false;
  
  const isTooEarly = punchInOrgTime.isBefore(windowOpen);
  const isTooLate = strictWindow && punchInOrgTime.isAfter(windowClose);
  const isValid = !isTooEarly && !isTooLate;
  
  const formatShiftTime = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const displayHours = h % 12 || 12;
    return `${String(displayHours).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
  };

  let reason = '';
  if (isTooEarly) {
    reason = `Punch-in too early. Shift starts at ${formatShiftTime(shiftStart)}. Please wait until ${formatShiftTime(shiftStart)}`;
  } else if (isTooLate) {
    const closeStr = policy?.allowLatePunchIn 
      ? `${policy.maxLateMinutes} minutes after shift start` 
      : formatShiftTime(shiftEnd);
    reason = `Punch-in denied. Shift window closed at ${closeStr}. Your shift has ended.`;
  }
  
  return {
    isValid,
    reason,
    isTooEarly,
    isTooLate,
    windowOpen: windowOpen.toDate(),
    windowClose: windowClose.toDate(),
    shiftStart: shiftStartMoment.toDate(),
    shiftEnd: shiftEndMoment.toDate(),
    punchTimeInOrg: punchInOrgTime.toDate()
  };
};

/**
 * Calculate working hours between two timestamps in org timezone
 * @param {Date} checkIn - Punch-in time (UTC)
 * @param {Date} checkOut - Punch-out time (UTC)
 * @param {String} timezone - Organization timezone
 * @returns {Number} - Working hours in decimal
 */
const calculateWorkingHours = (checkIn, checkOut, timezone = 'Asia/Kolkata') => {
  if (!checkIn || !checkOut) return 0;
  
  const checkInOrg = moment(checkIn).tz(timezone);
  const checkOutOrg = moment(checkOut).tz(timezone);
  
  const diffMinutes = checkOutOrg.diff(checkInOrg, 'minutes');
  return Math.round((diffMinutes / 60) * 100) / 100; // Round to 2 decimal places
};

/**
 * Calculate overtime hours beyond shift end
 * @param {Date} checkOut - Punch-out time (UTC)
 * @param {String} shiftEnd - "HH:MM" shift end time
 * @param {Boolean} isNextDay - Night shift flag
 * @param {Date} shiftStartDate - Date reference for shift start
 * @param {String} timezone - Organization timezone
 * @param {Number} overtimeThreshold - Minimum hours before OT kicks in
 * @returns {Number} - Overtime hours in decimal
 */
const calculateOvertime = (checkOut, shiftEnd, isNextDay, shiftStartDate, timezone = 'Asia/Kolkata', overtimeThreshold = null) => {
  if (!checkOut) return 0;
  
  const checkOutOrg = moment(checkOut).tz(timezone);
  const [endH, endM] = shiftEnd.split(':').map(Number);
  
  let shiftEndDate = moment(shiftStartDate).tz(timezone).startOf('day');
  shiftEndDate = shiftEndDate.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });
  
  if (isNextDay) {
    shiftEndDate = shiftEndDate.add(1, 'day');
  }
  
  // Only count overtime if punch-out is after shift end
  if (checkOutOrg.isSameOrBefore(shiftEndDate)) {
    return 0;
  }
  
  const overtimeMinutes = checkOutOrg.diff(shiftEndDate, 'minutes');
  const overtimeHours = Math.round((overtimeMinutes / 60) * 100) / 100;
  
  // Apply threshold if provided
  if (overtimeThreshold !== null && overtimeHours < overtimeThreshold) {
    return 0;
  }
  
  return overtimeHours;
};

/**
 * Determine punch-in status (ON_TIME, LATE, EARLY)
 * @param {Date} punchTime - Punch-in time (UTC)
 * @param {String} shiftStart - "HH:MM" shift start time
 * @param {Number} graceMinutes - Grace period
 * @param {String} timezone - Organization timezone
 * @returns {String} - Status string
 */
const getPunchInStatus = (punchTime, shiftStart, graceMinutes, timezone = 'Asia/Kolkata') => {
  const punchOrg = moment(punchTime).tz(timezone);
  const [startH, startM] = shiftStart.split(':').map(Number);
  
  const shiftStartDate = punchOrg.clone().startOf('day');
  const shiftStartMoment = shiftStartDate.set({ hour: startH, minute: startM, second: 0 });
  
  // Window: shiftStart - 30min (early) to shiftStart + graceMinutes (late)
  const earlyThreshold = shiftStartMoment.clone().subtract(30, 'minutes');
  const lateThreshold = shiftStartMoment.clone().add(graceMinutes, 'minutes');
  
  if (punchOrg.isBefore(earlyThreshold)) {
    return 'TOO_EARLY';
  } else if (punchOrg.isAfter(lateThreshold)) {
    return 'LATE';
  } else if (punchOrg.isBefore(shiftStartMoment)) {
    return 'EARLY';
  } else {
    return 'ON_TIME';
  }
};

/**
 * Get current date at midnight in org timezone (for attendance date field)
 * @param {String} timezone - IANA timezone
 * @returns {Date} - Midnight date in org timezone (stored in DB)
 */
const getTodayDateInOrgTimezone = (timezone = 'Asia/Kolkata') => {
  return moment().tz(timezone).startOf('day').toDate();
};

/**
 * Format date for display in org timezone
 * @param {Date} date - UTC date
 * @param {String} timezone - IANA timezone
 * @param {String} format - Display format (default: 'YYYY-MM-DD hh:mm A' - 12-hour AM/PM)
 * @returns {String} - Formatted date string
 */
const formatInTimezone = (date, timezone = 'Asia/Kolkata', format = 'YYYY-MM-DD hh:mm A') => {
  return moment(date).tz(timezone).format(format);
};

/**
 * Format time only (HH:MM AM/PM) for display
 * @param {Date} date - UTC date
 * @param {String} timezone - IANA timezone
 * @returns {String} - Formatted time string (e.g., "06:30 PM")
 */
const formatTimeOnly = (date, timezone = 'Asia/Kolkata') => {
  return moment(date).tz(timezone).format('hh:mm A');
};

/**
 * Format date only (YYYY-MM-DD) for display
 * @param {Date} date - UTC date
 * @param {String} timezone - IANA timezone
 * @returns {String} - Formatted date string (e.g., "2025-07-17")
 */
const formatDateOnly = (date, timezone = 'Asia/Kolkata') => {
  return moment(date).tz(timezone).format('YYYY-MM-DD');
};

/**
 * Format shift time string "HH:MM" to "hh:mm A" format
 * @param {String} timeStr - "HH:MM" format (e.g., "18:00")
 * @returns {String} - Formatted time (e.g., "06:00 PM")
 */
const formatShiftTime = (timeStr) => {
  if (!timeStr || !timeStr.match(/^\d{2}:\d{2}$/)) return timeStr;
  const [hours, minutes] = timeStr.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12; // Convert 0 to 12 for 12 AM
  return `${String(displayHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${period}`;
};

/**
 * Get day of week in org timezone
 * @param {Date} date - UTC date
 * @param {String} timezone - IANA timezone
 * @returns {String} - Day abbreviation (SUN, MON, TUE, etc.)
 */
const getDayOfWeek = (date, timezone = 'Asia/Kolkata') => {
  const DAY_MAP = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const dayIndex = moment(date).tz(timezone).day();
  return DAY_MAP[dayIndex];
};

// ─── Work week (AT-02) ───────────────────────────────────────────────
const DEFAULT_WORK_WEEK = ["MON", "TUE", "WED", "THU", "FRI"];
const DAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// Company work week (CompanyConfig.workWeek); Mon–Fri only as fallback
const workWeekSet = (workWeek) =>
  new Set(Array.isArray(workWeek) && workWeek.length ? workWeek : DEFAULT_WORK_WEEK);

// dayIndex = moment().day() → 0 = SUN ... 6 = SAT
const isWorkDayIndex = (dayIndex, set) => set.has(DAY_CODES[dayIndex]);

// ─── Night shift (AT-04) ─────────────────────────────────────────────
// A shift whose end is at/before its start crosses midnight, even if
// the isNextDay flag was not set when the shift was saved.
const toMinutesOfDay = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const resolveIsNextDay = (start, end, flag) =>
  !!flag || (!!start && !!end && toMinutesOfDay(end) <= toMinutesOfDay(start));

module.exports = {
  toOrgTimezone,
  toUTC,
  nowInTimezone,
  createTimeInTimezone,
  getMidnightInTimezone,
  validateShiftWindowTimezone,
  calculateWorkingHours,
  calculateOvertime,
  getPunchInStatus,
  getTodayDateInOrgTimezone,
  formatInTimezone,
  formatTimeOnly,
  formatDateOnly,
  formatShiftTime,
  getDayOfWeek,
  workWeekSet,
  isWorkDayIndex,
  resolveIsNextDay
};
