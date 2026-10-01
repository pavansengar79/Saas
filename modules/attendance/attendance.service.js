// modules/attendance/attendance.service.js

const Attendance = require("./models/attendance.model");
const Employee   = require("../employee/models/employee.model");
const AppError   = require("../../utils/appError");
const CompanyConfig = require("../companyConfig/models/companyConfig.model");
const { resolveAttendancePolicy } = require("../../utils/policyResolver");
const regularisationPolicyService = require("./regularisationPolicy.service");
const { calculatePolicyOvertime } = require("./overtimeCalculator");
const Holiday      = require("../holiday/models/holiday.models");     // T-19
const LeaveRequest = require("../leave/models/leaveRequest.models");  // T-20

// Shift + Roster resolution — dynamic shift per employee per day
// Priority: active roster → unit default shift → attendancePolicy fallback
const { resolveShiftForEmployee } = require("../shift/shift.service");

// Timezone utilities for enterprise HRMS
const {
  nowInTimezone,
  getTodayDateInOrgTimezone,
  validateShiftWindowTimezone,
  calculateWorkingHours,
  calculateOvertime,
  getPunchInStatus,
  formatInTimezone,
  formatTimeOnly,
  formatShiftTime,
  getDayOfWeek
} = require("../../utils/timezone");

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "YYYY-MM" string → { start: Date, end: Date } for the full month
 * Both dates are UTC midnight.
 */
const parseMonth = (monthStr) => {
  const [year, month] = monthStr.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));       // 1st of month
  const end   = new Date(Date.UTC(year, month, 1));            // 1st of next month
  return { start, end, year, month };
};

const buildMyAttendanceFilter = (employee, start, end) => ({
  org_id: employee.org_id,
  company_id: employee.company_id,
  unit_id: employee.unit_id,
  employeeId: employee._id,
  date: { $gte: start, $lt: end },
  isDeleted: false,
});

/**
 * Normalize any date to UTC midnight (date-only comparison)
 */
const toUTCMidnight = (date) => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * Parse "HH:MM" string into { hours, minutes }
 */
const parseTime = (timeStr) => {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return { hours, minutes };
};

/**
 * Calculate minutes late given checkIn time and shiftStart + graceMinutes
 * Returns { isLate, lateMinutes }
 */
const calcLateStatus = (checkInDate, shiftStart, graceMinutes) => {
  const { hours, minutes } = parseTime(shiftStart);

  // Shift start on same UTC date as checkIn
  const shiftStartTime = new Date(checkInDate);
  shiftStartTime.setUTCHours(hours, minutes + graceMinutes, 0, 0);

  const diffMs      = checkInDate - shiftStartTime;
  const lateMinutes = Math.max(0, Math.floor(diffMs / (1000 * 60)));
  const isLate      = lateMinutes > 0;

  return { isLate, lateMinutes };
};

/**
 * ─── SHIFT WINDOW VALIDATION ─────────────────────────────────────
 * Checks if punch-in is within allowed shift window.
 * 
 * Enterprise Rule: Employees can only punch-in during their shift hours.
 * - For day shifts (09:00-18:00): Punch-in allowed from shiftStart up to shiftEnd
 * - For night shifts (21:00-06:00): Punch-in allowed across midnight boundary
 * 
 * Policy Override: AttendancePolicy.shift.allowLatePunchIn can relax this
 * 
 * @param {Date} punchTime - Current time
 * @param {string} shiftStart - "HH:MM" format
 * @param {string} shiftEnd - "HH:MM" format  
 * @param {boolean} isNextDay - true for night shifts crossing midnight
 * @param {number} graceMinutes - grace period after shift start
 * @param {object} policy - AttendancePolicy with allowLatePunchIn, maxLateMinutes settings
 * @returns {isValid: boolean, reason: string, isTooEarly: boolean, isTooLate: boolean}
 */
const validateShiftWindow = (punchTime, shiftStart, shiftEnd, isNextDay, graceMinutes, policy = {}) => {
  const { hours: startH, minutes: startM } = parseTime(shiftStart);
  const { hours: endH, minutes: endM } = parseTime(shiftEnd);
  
  // Create shift start/end times for today
  const shiftStartTime = new Date(punchTime);
  shiftStartTime.setUTCHours(startH, startM, 0, 0);
  
  const shiftEndTime = new Date(punchTime);
  if (isNextDay) {
    // Night shift: endTime is next day
    shiftEndTime.setUTCDate(shiftEndTime.getUTCDate() + 1);
  }
  shiftEndTime.setUTCHours(endH, endM, 0, 0);
  
  // Calculate punch-in window boundaries
  // Window opens: shiftStart - 30 minutes (allow early arrival)
  // Window closes: shiftEnd (hard stop for day shift) or configurable for night shift
  const allowEarlyMinutes = policy?.allowEarlyMinutes ?? 30; // default 30 min before
  const windowOpenTime = new Date(shiftStartTime);
  windowOpenTime.setUTCMinutes(windowOpenTime.getUTCMinutes() - allowEarlyMinutes);
  
  let windowCloseTime = shiftEndTime;
  
  // Policy override: allowLatePunchIn with maxLateMinutes
  if (policy?.allowLatePunchIn && policy?.maxLateMinutes) {
    const extendedClose = new Date(shiftStartTime);
    extendedClose.setUTCMinutes(extendedClose.getUTCMinutes() + graceMinutes + policy.maxLateMinutes);
    windowCloseTime = extendedClose > shiftEndTime ? extendedClose : shiftEndTime;
  }
  
  // Allow configuration from policy for strict window
  const strictWindow = policy?.strictPunchWindow !== false; // default true
  
  const isTooEarly = punchTime < windowOpenTime;
  const isTooLate = strictWindow && punchTime > windowCloseTime;
  const isValid = !isTooEarly && !isTooLate;
  
  let reason = "";
  if (isTooEarly) {
    reason = `Punchin too early. Shift starts at ${shiftStart}. Please wait until ${shiftStart}`;
  } else if (isTooLate) {
    const closeStr = policy?.allowLatePunchIn 
      ? `${policy.maxLateMinutes} minutes after shift start`
      : shiftEnd;
    reason = `Punch-in denied. Shift window closed at ${closeStr}. Your shift has ended.`;
  }
  
  return {
    isValid,
    reason,
    isTooEarly,
    isTooLate,
    windowOpen: windowOpenTime,
    windowClose: windowCloseTime,
    shiftStart: shiftStartTime,
    shiftEnd: shiftEndTime
  };
};

/**
 * Get employee + validate tenant ownership
 * Throws 404 if not found
 */
const getEmployee = async (userId, org_id, company_id, unit_id) => {
  const filter = { userId, org_id, company_id, isDeleted: false };
  if (unit_id) filter.unit_id = unit_id;

  const employee = await Employee.findOne(filter);
  if (!employee) throw new AppError("Employee record not found", 404);
  return employee;
};

// ─────────────────────────────────────────────────────────────────────────────
// PUNCH IN
// POST /hrms/me/attendance/punch-in
// ─────────────────────────────────────────────────────────────────────────────

const Unit = require("../unit/models/unit.model")
const { validateGeoRadius, getIPLocation, reverseGeocode } = require("../../utils/locationConstants")
const geoip = require('geoip-lite')

// ─── Location Capture & Validation (Backend-Side) ──────────────────────────────
/**
 * Captures employee location with multiple fallback strategies:
 * 1. Frontend-provided GPS coordinates (most accurate)
 * 2. IP-based geolocation (using geoip-lite)
 * 3. Estimated location from employee's unit default
 */
const captureEmployeeLocation = async (req, unitId, employeeId) => {
  let locationData = {
    latitude: null,
    longitude: null,
    accuracy: null,
    source: 'unknown',
    message: ''
  }

  console.log(`[GeoLocation] === Starting location capture ===`)
  console.log(`[GeoLocation] Employee: ${employeeId}`)
  console.log(`[GeoLocation] Request body:`, req?.body?.geolocation)

  // Strategy 1: Use frontend-provided GPS coordinates (most accurate)
  if (req?.body?.geolocation?.latitude && req?.body?.geolocation?.longitude) {
    locationData = {
      latitude: req.body.geolocation.latitude,
      longitude: req.body.geolocation.longitude,
      accuracy: req.body.geolocation.accuracy || 10,
      source: 'gps',
      message: 'Location captured from device GPS'
    }
    console.log(`[GeoLocation] ✓ Using frontend GPS: lat=${locationData.latitude}, lng=${locationData.longitude}, accuracy=${locationData.accuracy}m`)
    return locationData
  }

  // Strategy 2: IP-based geolocation (backend-side)
  const clientIP = req?.ip || req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.connection?.remoteAddress
  console.log(`[GeoLocation] Client IP: ${clientIP}`)
  
  // Check if localhost - in development, allow fallback to unit coordinates
  const isLocalhost = !clientIP || clientIP === '::1' || clientIP === '127.0.0.1' || clientIP === '::ffff:127.0.0.1' || clientIP.startsWith('192.168.')
  
  if (!isLocalhost) {
    const geo = geoip.lookup(clientIP)
    console.log(`[GeoLocation] GeoIP lookup:`, geo ? { lat: geo.ll?.[0], lng: geo.ll?.[1], city: geo.city } : 'null')
    
    if (geo?.ll && geo.ll.length === 2) {
      locationData = {
        latitude: geo.ll[0],
        longitude: geo.ll[1],
        accuracy: 5000,
        source: 'ip',
        message: `Location estimated from IP (${clientIP})`,
        city: geo.city || null,
        region: geo.region || null,
        country: geo.country || null
      }
      console.log(`[GeoLocation] ✓ Using IP location: lat=${locationData.latitude}, lng=${locationData.longitude}, city=${locationData.city}`)
      return locationData
    }
  } else {
    console.log(`[GeoLocation] Skipping IP geolocation (localhost/private IP: ${clientIP})`)
  }

  // Strategy 3: Fallback to unit's default location (for development/testing)
  if (unitId) {
    const unit = await Unit.findById(unitId).select('geolocation name').lean()
    console.log(`[GeoLocation] Unit "${unit?.name}" geolocation:`, unit?.geolocation)
    
    if (unit?.geolocation?.latitude && unit?.geolocation?.longitude) {
      locationData = {
        latitude: unit.geolocation.latitude,
        longitude: unit.geolocation.longitude,
        accuracy: unit.geolocation.radiusMeters || 200,
        source: 'unit_default',
        message: `Location defaulted to unit "${unit.name}" coordinates (used for ${isLocalhost ? 'localhost development' : 'fallback'})`
      }
      console.log(`[GeoLocation] ✓ Using unit default location: lat=${locationData.latitude}, lng=${locationData.longitude}`)
      return locationData
    }
  }

  locationData.message = 'Location capture failed - no GPS/IP/Unit data available'
  console.log(`[GeoLocation] ✗ WARNING: ${locationData.message}`)
  return locationData
}

exports.punchIn = async (data, user, req = null) => {
  const { isWFH = false, remarks, geolocation } = data
  
  // ── 0. Fetch CompanyConfig for timezone ───────────────────────
  const companyConfig = await CompanyConfig.findOne({ org_id: user.orgId, company_id: user.companyId })
    .select('timezone overtimeThresholdHours overtimeEnabled halfDayThresholdHours')
    .lean();
  
  const timezone = companyConfig?.timezone || 'Asia/Kolkata';
  const now = new Date(); // UTC timestamp
  const nowOrgTime = nowInTimezone(timezone); // Current time in org timezone
  
  // ── 1. Get employee ──────────────────────────────────────────
  const employee = await getEmployee(user.userId, user.orgId, user.companyId, user.unitId)

  // ── 2. Today ki date (org timezone midnight) ──────────────────
  const today = getTodayDateInOrgTimezone(timezone);

  // ── 3. Fetch Unit with geolocation settings ─────────────────────────────
  const unit = await Unit.findById(user.unitId).select('geolocation locationSettings name').lean()
  
  // ── 4. Location Capture (Backend-Side with fallbacks) ─────────────────────
  // Skip location validation for WFH
  let capturedLocation = null
  let geoValidation = null
  
  if (!isWFH) {
    // Capture location using multiple strategies
    capturedLocation = await captureEmployeeLocation(req, user.unitId, employee._id)
    
    // Validate against unit geofence if configured
    if (unit?.geolocation?.latitude && unit?.geolocation?.longitude) {
      geoValidation = validateGeoRadius(
        { latitude: capturedLocation.latitude, longitude: capturedLocation.longitude },
        unit.geolocation
      )
      
      // Log location validation
      console.log(`[GeoLocation] Employee: ${employee._id}, Unit: ${unit.name}`)
      console.log(`[GeoLocation] Captured: lat=${capturedLocation.latitude}, lng=${capturedLocation.longitude}, source=${capturedLocation.source}`)
      console.log(`[GeoLocation] Distance from unit: ${geoValidation.distance}m (Allowed: ${geoValidation.allowedRadius}m)`)
      console.log(`[GeoLocation] Valid: ${geoValidation.isValid}, Message: ${geoValidation.message}`)
      
      // ── GEO-FENCING ENFORCEMENT ─────────────────────────────
      // If unit has geoFencingEnabled, enforce strict validation
      if (unit?.locationSettings?.geoFencingEnabled) {
        // Strict blocking mode: Employee MUST be within radius
        if (!geoValidation.isValid && !unit.locationSettings.allowOutsidePunch) {
          console.log(`[GeoLocation] BLOCKED: Employee outside allowed radius`)
          throw new AppError(
            `Punch-in denied. You are outside the allowed location.\n` +
            `Distance from ${unit.name}: ${geoValidation.distance}m (Allowed: within ${geoValidation.allowedRadius}m)\n` +
            `Your location: ${capturedLocation.latitude?.toFixed(4)}, ${capturedLocation.longitude?.toFixed(4)}`,
            403
          )
        }
        
        // Warning mode (allowOutsidePunch: true): Log but allow
        if (!geoValidation.isValid && unit.locationSettings.allowOutsidePunch) {
          console.log(`[GeoLocation] WARNING: Employee outside radius but allowed to punch (allowOutsidePunch=true)`)
        }
      }
    } else {
      console.log(`[GeoLocation] Unit ${unit?.name || user.unitId} has no geolocation configured - validation skipped`)
    }
  } else {
    console.log(`[GeoLocation] WFH punch-in - location validation skipped for employee ${employee._id}`)
  }

  // ── 3. Already punch-in check ─────────────────────────────────
  const existing = await Attendance.findOne({
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    user.unitId,
    employeeId: employee._id,
    date:       today,
  });

  if (existing) {
    if (existing.checkIn) {
      throw new AppError(
        existing.checkOut
          ? "Aap aaj ke liye already punch-in aur punch-out kar chuke hain"
          : "Aap aaj already punch-in kar chuke hain. Pehle punch-out karein",
        409
      );
    }
  }

  // ── 4. Weekend check ─────────────────────────────────────────
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    // Allow punch-in on weekends but mark accordingly
    // (Some employees work on weekends — HR can regularize)
  }

  // ── 5. Employee active check ──────────────────────────────────
  if (employee.status !== "ACTIVE") {
    throw new AppError(
      `Inactive employee punch-in nahi kar sakta (status: ${employee.status})`,
      403
    );
  }

  // ── T-19: Holiday check ─────────────────────────────────────
  const holiday = await Holiday.findOne({
    org_id:     user.orgId,
    company_id: user.companyId,
    // For unit-level employees, check unit-specific holiday or company-wide holiday
    ...(user.unitId && { $or: [{ unit_id: user.unitId }, { unit_id: null }] }),
    date:       { $gte: today, $lt: new Date(today.getTime() + 86400000) },
    isDeleted:  false,
  }).select("name type").lean();

  // ── T-20: Approved leave check ───────────────────────────────
  const approvedLeave = await LeaveRequest.findOne({
    employeeId: employee._id,
    status:     "APPROVED",
    startDate:  { $lte: today },
    endDate:    { $gte: today },
  }).select("leaveTypeId").lean();

  // ── 6. Resolve shift dynamically ─────────────────────────────
  //
  // Priority chain (fully dynamic — nothing hardcoded):
  //   1. Employee ka active roster for today → use roster's shift values
  //   2. Unit ka isDefault:true ACTIVE shift → use default shift values
  //   3. AttendancePolicy fallback → use policy's shift config
  //   4. Last resort defaults → "09:00", 15 min grace, 8 hrs
  //
  // shiftSource saved in attendance record for audit trail

  let shiftStart      = "09:00";  // last resort default
  let shiftEnd        = "18:00";  // last resort default
  let isNextDay       = false;   // night shift flag
  let graceMinutes    = 15;
  let standardHours   = 8;
  let halfDayThreshold = 4;
  let shiftId         = null;
  let shiftSource     = "policy_default"; // "roster" | "default_shift" | "policy" | "policy_default"
  let resolvedShiftId = null;
  let resolvedRosterId = null;

  // Step 1 & 2 — try roster → default shift
  try {
    const shiftResult = await resolveShiftForEmployee(
      employee._id,
      user.unitId,
      user.orgId,
      user.companyId,
      today
    );

    if (shiftResult?.shift) {
      const s         = shiftResult.shift;
      shiftStart      = s.startTime;                               // "HH:MM"
      shiftEnd        = s.endTime;                                 // "HH:MM"
      isNextDay       = s.isNextDay ?? false;                      // night shift
      graceMinutes    = s.gracePeriodMinutes    ?? 15;
      standardHours   = (s.workingMinutes ?? 480) / 60;           // minutes → hours
      halfDayThreshold = (s.halfDayThresholdMinutes ?? 240) / 60; // minutes → hours
      shiftId         = s._id;
      shiftSource     = shiftResult.source;                        // "roster" or "default"
      resolvedShiftId  = s._id;
      resolvedRosterId = shiftResult.roster_id || null;
    }
  } catch (_) {
    // Shift resolution failure non-fatal — fall through to policy
  }

  // Step 3 — AttendancePolicy (always resolved, used as fallback or supplement)
  const attendancePolicy = await resolveAttendancePolicy(
    employee._id.toString(),
    user.companyId.toString(),
    user.unitId ? user.unitId.toString() : null
  );

  // If no shift found from roster/default → use policy values
  if (shiftSource === "policy_default" && attendancePolicy) {
    shiftStart       = attendancePolicy.shift?.start          ?? "09:00";
    shiftEnd         = attendancePolicy.shift?.end          ?? "18:00";
    isNextDay        = attendancePolicy.shift?.isNextDay     ?? false;
    graceMinutes     = attendancePolicy.shift?.graceMinutes   ?? 15;
    standardHours    = attendancePolicy.shift?.minimumHours   ?? 8;
    halfDayThreshold = attendancePolicy.shift?.halfDayMinHours ?? 4;
    shiftSource      = "policy";
  }

  // CompanyConfig — overtime threshold (supplement, not replaced by shift)
  const config = companyConfig; // Already fetched at top

  const overtimeThreshold = config?.overtimeThresholdHours ?? standardHours + 1;
  const overtimeEnabled = config?.overtimeEnabled ?? true; // OT enabled by default
  // CompanyConfig halfDay override if explicitly set
  if (config?.halfDayThresholdHours) halfDayThreshold = config.halfDayThresholdHours;

  // ── 6b. SHIFT WINDOW VALIDATION (Enterprise HRMS - Timezone Aware) ─
  // Validate punch-in is within allowed shift window
  // Policy can override: allowLatePunchIn, maxLateMinutes, strictPunchWindow
  const shiftPolicy = attendancePolicy?.shift || {};
  
  const windowValidation = validateShiftWindowTimezone(
    now, // UTC punch time
    shiftStart,
    shiftEnd,
    isNextDay,
    graceMinutes,
    timezone, // Organization timezone
    shiftPolicy
  );
  
  // Only enforce if policy has strictPunchWindow enabled (default true)
  if (shiftPolicy.strictPunchWindow !== false) {
    if (!windowValidation.isValid) {
      throw new AppError(
        windowValidation.reason ||
        `Punch-in denied. Your shift is ${formatShiftTime(shiftStart)} - ${formatShiftTime(shiftEnd)}.`,
        403
      );
    }
  }

  // Determine punch-in status using timezone-aware function
  const punchInStatus = getPunchInStatus(now, shiftStart, graceMinutes, timezone);
  const isLate = punchInStatus === 'LATE';
  const lateMinutes = isLate ? Math.ceil((nowOrgTime - windowValidation.shiftStart) / (1000 * 60)) : 0;

  // ── 7. Determine initial status (T-19 + T-20) ────────────────
  // IMPORTANT: If employee punches in, status reflects attendance, NOT holiday
  // Holiday status is only for auto-generated records when no one punches in
  let status = "PRESENT";
  if (approvedLeave)  status = "ON_LEAVE";       // T-20
  if (isWFH)          status = "WFH";
  if (isLate)         status = "LATE";

  // ── 8. Create or update record ────────────────────────────────
  const record = await Attendance.findOneAndUpdate(
    {
      org_id:     user.orgId,
      company_id: user.companyId,
      unit_id:    user.unitId,
      employeeId: employee._id,
      date:       today,
    },
    {
      $setOnInsert: {
        org_id:       user.orgId,
        company_id:   user.companyId,
        unit_id:      user.unitId,
        employeeId:   employee._id,
        userId:       user.userId,
        date:         today,
        standardHours,
        shiftStart,
        shiftEnd,
        graceMinutes,
        isNextDay,
        // Shift resolution metadata — audit trail + punch-out uses same values
        shiftId:          resolvedShiftId  || null,  // Shift doc used
        rosterId:         resolvedRosterId || null,   // Roster doc (null if default/policy)
        shiftSource,                                  // "roster"|"default_shift"|"policy"|"policy_default"
        halfDayThreshold,                             // stored so punch-out doesn't re-resolve
        overtimeThreshold,                            // stored so punch-out uses same value
        createdBy:    user.userId,
      },
      $set: {
        checkIn:     now,
        status,
        isLate,
        lateMinutes,
        isWFH,
        remarks:     remarks || null,
        updatedBy:   user.userId,
        // ─── Save Location Data (captured from backend) ─────────────────────────
        ...(capturedLocation?.latitude && capturedLocation?.longitude && {
          checkInLocation: {
            latitude: capturedLocation.latitude,
            longitude: capturedLocation.longitude,
            accuracy: capturedLocation.accuracy || null,
            timestamp: now,
            isValid: geoValidation?.isValid ?? null,
            distance: geoValidation?.distance ?? null,
            source: capturedLocation.source || 'unknown',
            message: capturedLocation.message || ''
          }
        }),
      },
    },
    { upsert: true, new: true }
  );

  return record;
};

// ─────────────────────────────────────────────────────────────────────────────
// PUNCH OUT
// POST /hrms/me/attendance/punch-out
// ─────────────────────────────────────────────────────────────────────────────

exports.punchOut = async (data, user) => {
  const { remarks } = data;
  
  // ── 0. Fetch CompanyConfig for timezone ───────────────────────
  const companyConfig = await CompanyConfig.findOne({ org_id: user.orgId, company_id: user.companyId })
    .select('timezone overtimeThresholdHours overtimeEnabled halfDayThresholdHours')
    .lean();
  
  const timezone = companyConfig?.timezone || 'Asia/Kolkata';
  const now = new Date(); // UTC timestamp
  const nowOrgTime = nowInTimezone(timezone); // Current time in org timezone

  // ── 1. Get employee ──────────────────────────────────────────
  const employee = await getEmployee(user.userId, user.orgId, user.companyId, user.unitId);
  const attendancePolicy = await resolveAttendancePolicy(
    employee._id.toString(),
    user.companyId.toString(),
    user.unitId ? user.unitId.toString() : null
  );

  // ── 2. Today ka record dhundo (org timezone midnight) ─────────
  const today = getTodayDateInOrgTimezone(timezone);

  const record = await Attendance.findOne({
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    user.unitId,
    employeeId: employee._id,
    date:       today,
  });

  // ── 3. Edge cases ─────────────────────────────────────────────
  if (!record || !record.checkIn) {
    throw new AppError("Pehle punch-in karein", 400);
  }

  if (record.checkOut) {
    throw new AppError(
      "Aap aaj already punch-out kar chuke hain",
      409
    );
  }

  // ── 4. checkOut can't be before checkIn ──────────────────────
  if (now < record.checkIn) {
    throw new AppError(
      "Punch-out time punch-in se pehle nahi ho sakta",
      400
    );
  }

  // ── 5. Minimum working time check (5 minutes) ────────────────
  const diffMinutes = (now - record.checkIn) / (1000 * 60);
  if (diffMinutes < 5) {
    throw new AppError(
      "Punch-in ke 5 minute baad hi punch-out kar sakte hain",
      400
    );
  }

  // ── 6. workingHours & overtimeHours (timezone-aware) ─────────
  // Calculate using timezone-aware utility
  const workingHours = calculateWorkingHours(record.checkIn, now, timezone);
  const detectedOvertimeHours = calculateOvertime(
    now,
    record.shiftEnd,
    record.isNextDay,
    record.date,
    timezone,
    0
  );
  const overtimeHours = calculatePolicyOvertime(
    detectedOvertimeHours,
    attendancePolicy.overtime
  );
  
  record.checkOut  = now;
  record.workingHours = workingHours;
  record.overtimeHours = overtimeHours;
  record.updatedBy = user.userId;
  if (remarks) record.remarks = remarks;

  // ── T-22: HALF_DAY auto detection ─────────────────────────────
  // Use stored halfDayThreshold + standardHours from punchIn record
  // (already resolved from roster/shift/policy at punch-in time)
  // No DB re-query needed — values saved in $setOnInsert
  try {
    // Read thresholds from the record itself (saved at punch-in from shift resolution)
    const halfDayMin = record.halfDayThreshold  || 4;
    const fullDayMin = record.standardHours     || 8;

    // Only auto-update if currently PRESENT, WFH, or LATE
    const autoStatuses = ["PRESENT", "WFH", "LATE"];
    if (autoStatuses.includes(record.status)) {
      if (workingHours < halfDayMin) {
        // Worked less than halfDay threshold
        // If was LATE → keep LATE (still attended, just short)
        // PRESENT/WFH → mark HALF_DAY
        if (record.status !== "LATE") record.status = "HALF_DAY";
      } else if (workingHours >= halfDayMin && workingHours < fullDayMin) {
        record.status = "HALF_DAY";
      }
      // >= fullDayMin → status stays (PRESENT / WFH / LATE)
    }
  } catch (e) {
    // Non-fatal — status stays as-is
    console.error("HALF_DAY detection error:", e.message);
  }

  await record.save();

  return record;
};


// ─────────────────────────────────────────────────────────────────────────────
// GET MY ATTENDANCE
// GET /hrms/me/attendance?month=YYYY-MM
// ─────────────────────────────────────────────────────────────────────────────

exports.getMyAttendance = async (query, user) => {
  const { month } = query;
  const { start, end, year, month: monthNum } = parseMonth(month);

  // ── 1. Get employee ──────────────────────────────────────────
  const employee = await getEmployee(user.userId, user.orgId, user.companyId, user.unitId);

  // ── 2. Fetch records for the month ───────────────────────────
  const records = await Attendance.find(buildMyAttendanceFilter(employee, start, end))
    .sort({ date: 1 })
    .select("-__v -isDeleted");

  // ── 3. Build summary ─────────────────────────────────────────
  const summary = {
    totalDays:     0,
    present:       0,
    absent:        0,
    late:          0,
    halfDay:       0,
    onLeave:       0,
    holiday:       0,
    weekend:       0,
    wfh:           0,
    totalWorkingHours:  0,
    totalOvertimeHours: 0,
  };

  // Count days in month
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  summary.totalDays = daysInMonth;

  records.forEach((r) => {
    switch (r.status) {
      case "PRESENT":  summary.present++;  break;
      case "ABSENT":   summary.absent++;   break;
      case "LATE":     summary.late++;     summary.present++; break; // LATE = attended
      case "HALF_DAY": summary.halfDay++;  break;
      case "ON_LEAVE": summary.onLeave++;  break;
      case "HOLIDAY":  summary.holiday++;  break;
      case "WEEKEND":  summary.weekend++;  break;
      case "WFH":      summary.wfh++;      summary.present++; break;
    }
    if (r.workingHours)  summary.totalWorkingHours  += r.workingHours;
    if (r.overtimeHours) summary.totalOvertimeHours += r.overtimeHours;
  });

  // Round totals
  summary.totalWorkingHours  = parseFloat(summary.totalWorkingHours.toFixed(2));
  summary.totalOvertimeHours = parseFloat(summary.totalOvertimeHours.toFixed(2));

  return {
    employee: {
      id:           employee._id,
      name:         employee.name,
      employeeId:   employee.employeeId,
      profilePhoto: employee.profilePhoto || null,
    },
    month,
    year,
    summary,
    records,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET TODAY'S STATUS
// GET /hrms/me/attendance/today
// ─────────────────────────────────────────────────────────────────────────────

exports.getTodayStatus = async (user) => {
  const employee = await getEmployee(user.userId, user.orgId, user.companyId, user.unitId);
  
  // CRITICAL: Use org timezone to match the date field used during punch-in
  // Attendance records are created with org timezone midnight (getTodayDateInOrgTimezone)
  const CompanyConfig = require('../companyConfig/models/companyConfig.model');
  const config = await CompanyConfig.findOne({ org_id: user.orgId, company_id: user.companyId }).select('timezone').lean();
  const timezone = config?.timezone || 'Asia/Kolkata';
  const today = getTodayDateInOrgTimezone(timezone);

  const record = await Attendance.findOne({
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    user.unitId,
    employeeId: employee._id,
    date:       today,
  }).select("-__v -isDeleted");

  return {
    date:      today,
    employee: {
      id:           employee._id,
      name:         employee.name,
      employeeId:   employee.employeeId,
      profilePhoto: employee.profilePhoto || null,
    },
    attendance: record || null,
    // Convenient flags for frontend
    hasPunchedIn:  !!record?.checkIn,
    hasPunchedOut: !!record?.checkOut,
    isPunchedIn:   !!record?.checkIn && !record?.checkOut,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDANCE SUMMARY
// GET /hrms/me/attendance/summary?month=YYYY-MM
// ─────────────────────────────────────────────────────────────────────────────

exports.getMySummary = async (query, user) => {
  const { month } = query;
  const { start, end, year, month: monthNum } = parseMonth(month);

  const employee = await getEmployee(user.userId, user.orgId, user.companyId, user.unitId);

  // Aggregate for performance on large datasets
  const agg = await Attendance.aggregate([
    {
      $match: {
        ...buildMyAttendanceFilter(employee, start, end),
      },
    },
    {
      $group: {
        _id:                null,
        totalRecords:       { $sum: 1 },
        present:            { $sum: { $cond: [{ $in: ["$status", ["PRESENT", "WFH", "LATE"]] }, 1, 0] } },
        absent:             { $sum: { $cond: [{ $eq: ["$status", "ABSENT"] }, 1, 0] } },
        late:               { $sum: { $cond: [{ $eq: ["$status", "LATE"] }, 1, 0] } },
        halfDay:            { $sum: { $cond: [{ $eq: ["$status", "HALF_DAY"] }, 1, 0] } },
        onLeave:            { $sum: { $cond: [{ $eq: ["$status", "ON_LEAVE"] }, 1, 0] } },
        holiday:            { $sum: { $cond: [{ $eq: ["$status", "HOLIDAY"] }, 1, 0] } },
        weekend:            { $sum: { $cond: [{ $eq: ["$status", "WEEKEND"] }, 1, 0] } },
        wfh:                { $sum: { $cond: [{ $eq: ["$status", "WFH"] }, 1, 0] } },
        totalWorkingHours:  { $sum: { $ifNull: ["$workingHours",  0] } },
        totalOvertimeHours: { $sum: { $ifNull: ["$overtimeHours", 0] } },
        totalLateMinutes:   { $sum: { $ifNull: ["$lateMinutes",   0] } },
      },
    },
  ]);

  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const stats       = agg[0] || {};

  return {
    employee: {
      id:           employee._id,
      name:         employee.name,
      employeeId:   employee.employeeId,
      profilePhoto: employee.profilePhoto || null,
    },
    month,
    daysInMonth,
    summary: {
      present:            stats.present            || 0,
      absent:             stats.absent             || 0,
      late:               stats.late               || 0,
      halfDay:            stats.halfDay            || 0,
      onLeave:            stats.onLeave            || 0,
      holiday:            stats.holiday            || 0,
      weekend:            stats.weekend            || 0,
      wfh:                stats.wfh                || 0,
      totalWorkingHours:  parseFloat((stats.totalWorkingHours  || 0).toFixed(2)),
      totalOvertimeHours: parseFloat((stats.totalOvertimeHours || 0).toFixed(2)),
      totalLateMinutes:   stats.totalLateMinutes   || 0,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL EMPLOYEES ATTENDANCE (HR)
// GET /hrms/attendance?month=YYYY-MM&employeeId=&status=
// ─────────────────────────────────────────────────────────────────────────────

exports.getAllAttendance = async (query, user) => {
  const {
    orgId: requestedOrgId,
    companyId: requestedCompanyId,
    unit_id: requestedUnitId,
    month,
    startDate,
    endDate,
    employeeId,
    departmentId,
    status,
    page  = 1,
    limit = 31,
  } = query;

  if (user.role !== "SUPER_ADMIN" && requestedOrgId && String(requestedOrgId) !== String(user.orgId)) {
    throw new AppError("Organization access denied", 403);
  }
  if (user.companyId && requestedCompanyId && String(requestedCompanyId) !== String(user.companyId)) {
    throw new AppError("Company access denied", 403);
  }
  if (user.unitId && requestedUnitId && String(requestedUnitId) !== String(user.unitId)) {
    throw new AppError("Unit access denied", 403);
  }

  const orgId = user.role === "SUPER_ADMIN" ? requestedOrgId : user.orgId;
  const companyId = user.companyId || requestedCompanyId;
  const unitId = user.unitId || requestedUnitId;

  if (!orgId) throw new AppError("orgId is required", 400);
  if (!companyId) throw new AppError("companyId is required", 400);

  const filter = {
    org_id: orgId,
    company_id: companyId,
    isDeleted: false,
  };
  
  if (unitId) filter.unit_id = unitId;

  // Date range handling
  const moment = require("moment-timezone");
  const ORG_TZ = "Asia/Kolkata"; // TODO: pull from company config if per-org timezone varies

  if (startDate && endDate) {
    const start = moment.tz(`${startDate} 00:00:00`, ORG_TZ).utc().toDate();
    const end   = moment.tz(`${endDate} 23:59:59.999`, ORG_TZ).utc().toDate();
    filter.date = { $gte: start, $lte: end };
  } else if (month) {
    const { start, end } = parseMonth(month);
    filter.date = { $gte: start, $lt: end };
  } else {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    filter.date = { $gte: start, $lte: end };
  }

  // Employee-specific filters
  if (employeeId) {
    filter.employeeId = employeeId;
  } else if (departmentId) {
    // If department filter is applied, find employees in that department first
    const Employee = require("../employee/models/employee.model");
    const deptEmployees = await Employee.find({
      departmentId: departmentId,
      org_id: orgId,
      company_id: companyId,
      ...(unitId && { unit_id: unitId }),
      isDeleted: false,
      status: "ACTIVE"
    }).select("_id");
    
    if (deptEmployees.length > 0) {
      filter.employeeId = { $in: deptEmployees.map(e => e._id) };
    } else {
      // No employees in this department - return empty result
      return {
        page: Number(page),
        limit: Number(limit),
        total: 0,
        records: [],
      };
    }
  }

  if (status) filter.status = status;

  const skip = (page - 1) * limit;

  const [records, total] = await Promise.all([
    Attendance.find(filter)
      .populate("employeeId", "name employeeId email departmentId profilePhoto")
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .select("-__v -isDeleted"),
    Attendance.countDocuments(filter),
  ]);

  return {
    page:    Number(page),
    limit:   Number(limit),
    total,
    records,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET TEAM ATTENDANCE (Manager)
// GET /hrms/attendance/team?month=YYYY-MM&employeeId=&status=
// Manager sees attendance of employees reporting to them
// ─────────────────────────────────────────────────────────────────────────────

exports.getTeamAttendance = async (query, user) => {
  const {
    month,
    startDate,
    endDate,
    employeeId,
    status,
    page  = 1,
    limit = 31,
  } = query;

  // ── 1. Get manager's employee record ─────────────────────────────────────
  const manager = await Employee.findOne({
    userId:    user.userId,
    org_id:    user.orgId,
    status:    "ACTIVE",
    isDeleted: false,
  }).select("_id");

  if (!manager) {
    throw new AppError("Manager employee record not found", 404);
  }

  // ── 2. Get team members (direct reports) ──────────────────────────────────
  const teamMembers = await Employee.find({
    reportingManagerId: manager._id,
    org_id:             user.orgId,
    company_id:         user.companyId,
    status:             "ACTIVE",
    isDeleted:          false,
  }).select("_id");

  let teamIds = [manager._id, ...teamMembers.map(e => e._id)];

  // ── 3. Build filter ───────────────────────────────────────────────────────
  const filter = {
    org_id:     user.orgId,
    company_id: user.companyId,
    isDeleted:  false,
  };

  // Date range handling
  const moment = require("moment-timezone");
  const ORG_TZ = "Asia/Kolkata";

  if (startDate && endDate) {
    const start = moment.tz(`${startDate} 00:00:00`, ORG_TZ).utc().toDate();
    const end   = moment.tz(`${endDate} 23:59:59.999`, ORG_TZ).utc().toDate();
    filter.date = { $gte: start, $lte: end };
  } else if (month) {
    const { start, end } = parseMonth(month);
    filter.date = { $gte: start, $lt: end };
  } else {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    filter.date = { $gte: start, $lte: end };
  }

  // Employee filter (higher priority than team filter)
  if (employeeId) {
    filter.employeeId = employeeId;
  } else {
    // Default: show all team members
    filter.employeeId = { $in: teamIds };
  }

  if (status) filter.status = status;

  const skip = (page - 1) * limit;

  const [records, total] = await Promise.all([
    Attendance.find(filter)
      .populate("employeeId", "name employeeId email departmentId profilePhoto")
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .select("-__v -isDeleted"),
    Attendance.countDocuments(filter),
  ]);

  // ── If filtering by single day (today/yesterday), show ALL team members ────────
  // If no records exist for an employee on a working day, mark as ABSENT
  if (startDate && endDate && startDate === endDate) {
    const filterStart = new Date(startDate);
    filterStart.setHours(0, 0, 0, 0);
    const filterEnd = new Date(endDate);
    filterEnd.setHours(23, 59, 59, 999);
    
    // Check if it's a single day filter
    const isSingleDay = filterStart.getTime() === filterEnd.getTime() || 
                        (filterEnd - filterStart) === 86399999;
    
    if (isSingleDay) {
      const dayOfWeek = filterStart.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      
      // If not a weekend, find employees without attendance records
      if (!isWeekend) {
        // Get all team members with full details
        const allTeamMembers = await Employee.find({
          _id: { $in: teamIds },
          org_id: user.orgId,
          company_id: user.companyId,
          status: "ACTIVE",
          isDeleted: false,
        }).select("_id name employeeId email departmentId profilePhoto");
        
        // Find which employees already have attendance records
        const employeesWithRecords = new Set(records.map(r => r.employeeId?._id?.toString() || r.employeeId?.toString()));
        
        // Create ABSENT records for missing employees
        const absentRecords = allTeamMembers
          .filter(emp => !employeesWithRecords.has(emp._id.toString()))
          .map(emp => ({
            _id: `absent-${emp._id}`,
            employeeId: emp,
            date: filterStart,
            status: 'ABSENT',
            checkIn: null,
            checkOut: null,
            workingHours: 0,
            isWFH: false,
            remarks: 'Auto-marked absent (no attendance record)',
            isAutoMarked: true,
          }));
        
        // Combine existing records with absent records
        return {
          page: Number(page),
          limit: Number(limit),
          total: records.length + absentRecords.length,
          records: [...records, ...absentRecords],
        };
      }
    }
  }

  return {
    page:    Number(page),
    limit:   Number(limit),
    total,
    records,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// REGULARIZE (HR only)
// PATCH /hrms/attendance/:id/regularize
// ─────────────────────────────────────────────────────────────────────────────

exports.regularize = async (attendanceId, data, user, query = {}) => {
  const { status, checkIn, checkOut, remarks, regularizationType, attachments = [] } = data;

  if (!regularizationType) {
    throw new AppError("regularizationType is required", 400);
  }

  const { orgId: requestedOrgId, companyId: requestedCompanyId, unit_id: requestedUnitId } = query;
  if (user.role !== "SUPER_ADMIN" && requestedOrgId && String(requestedOrgId) !== String(user.orgId)) {
    throw new AppError("Organization access denied", 403);
  }
  if (user.companyId && requestedCompanyId && String(requestedCompanyId) !== String(user.companyId)) {
    throw new AppError("Company access denied", 403);
  }
  if (user.unitId && requestedUnitId && String(requestedUnitId) !== String(user.unitId)) {
    throw new AppError("Unit access denied", 403);
  }

  const orgId = user.role === "SUPER_ADMIN" ? requestedOrgId : user.orgId;
  const companyId = user.companyId || requestedCompanyId;
  const unitId = user.unitId || requestedUnitId;

  if (!orgId) throw new AppError("orgId is required", 400);
  if (!companyId) throw new AppError("companyId is required", 400);

  // ── 1. Record dhundo — same tenant mein ──────────────────────
  const record = await Attendance.findOne({
    _id:        attendanceId,
    org_id:     orgId,
    company_id: companyId,
    ...(unitId ? { unit_id: unitId } : {}),
  });

  if (!record) throw new AppError("Attendance record not found", 404);

  const employee = await Employee.findOne({
    _id: record.employeeId,
    org_id: orgId,
    company_id: companyId,
    isDeleted: false,
  }).lean();
  if (!employee) throw new AppError("Employee record not found", 404);

  const policy = await regularisationPolicyService.getEffectivePolicy(employee, user, {
    orgId,
    companyId,
    unit_id: unitId,
  });
  const policyType = regularisationPolicyService.getPolicyTypeForRegularization(policy, regularizationType);
  if (!policyType) {
    throw new AppError(`Correction type '${regularizationType}' is not allowed by the active policy`, 400);
  }

  const validation = await regularisationPolicyService.validateRequestAgainstPolicy(
    policy,
    { type: policyType, date: record.date, attachments },
    0
  );
  if (!validation.valid) throw new AppError(validation.errors.join("; "), 400);

  const requiresCheckIn = ["MISSED_PUNCH_IN", "BOTH_MISSED", "WRONG_TIME"].includes(regularizationType);
  const requiresCheckOut = ["MISSED_PUNCH_OUT", "BOTH_MISSED", "WRONG_TIME"].includes(regularizationType);

  if (requiresCheckIn && !checkIn) {
    throw new AppError("Check-in time is required for the selected correction type", 400);
  }
  if (requiresCheckOut && !checkOut) {
    throw new AppError("Check-out time is required for the selected correction type", 400);
  }

  // ── 2. checkOut before checkIn guard ─────────────────────────
  const newCheckIn  = checkIn  ? new Date(checkIn)  : record.checkIn;
  const newCheckOut = checkOut ? new Date(checkOut) : record.checkOut;

  if (newCheckIn && newCheckOut && newCheckOut < newCheckIn) {
    throw new AppError("Check-out time, check-in se pehle nahi ho sakta", 400);
  }

  // ── 3. Apply changes ──────────────────────────────────────────
  record.status          = status;
  record.remarks         = remarks;
  record.isRegularized   = true;
  record.regularizedBy   = user.userId;
  record.regularizedAt   = new Date();
  record.updatedBy       = user.userId;

  if (checkIn)  record.checkIn  = new Date(checkIn);
  if (checkOut) record.checkOut = new Date(checkOut);

  await record.save(); // pre-save recalculates workingHours
  await record.populate("employeeId", "name employeeId email departmentId profilePhoto");

  return record;
};

// ─────────────────────────────────────────────────────────────────────────────
// Get all currently clocked-in employees with their profile info
// ─────────────────────────────────────────────────────────────────────────────
exports.getAllClockedIn = async (user) => {
  // CRITICAL: Use org timezone to match the date field used during punch-in
  // Attendance records are created with org timezone midnight (getTodayDateInOrgTimezone)
  // If we use UTC midnight here, we'll get NO RESULTS for IST timezone
  const CompanyConfig = require('../companyConfig/models/companyConfig.model');
  const config = await CompanyConfig.findOne({ org_id: user.orgId, company_id: user.companyId }).select('timezone').lean();
  const timezone = config?.timezone || 'Asia/Kolkata';
  
  const today = getTodayDateInOrgTimezone(timezone);

  // Find all attendance records for today where checkOut is null (still clocked in)
  const clockedInRecords = await Attendance.find({
    org_id: user.orgId,
    company_id: user.companyId,
    unit_id: user.unitId,
    date: today,
    checkOut: null, // Still clocked in
    isDeleted: false
  }).populate({
    path: 'employeeId',
    select: '_id userId name email phone profilePhoto designationId departmentId',
    populate: [
      { path: 'designationId', select: 'name' },
      { path: 'departmentId', select: 'name' }
    ]
  }).lean();

  // Format the response with employee profile info
  const result = clockedInRecords.map(record => ({
    attendanceId: record._id,
    employeeId: record.employeeId._id,
    name: record.employeeId.name,
    email: record.employeeId.email,
    phone: record.employeeId.phone,
    profilePhoto: record.employeeId.profilePhoto,
    designation: record.employeeId.designationId?.name || null,
    department: record.employeeId.departmentId?.name || null,
    checkIn: record.checkIn,
    workingHours: record.workingHours,
    status: record.status,
    isWFH: record.isWFH || false
  }));

  return {
    total: result.length,
    employees: result
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN PUNCH-IN (Biometric Sync Helper)
// POST /hrms/attendance/admin/punch-in
// Called by biometric sync to punch-in on behalf of employee
// ─────────────────────────────────────────────────────────────────────────────
exports.adminPunchIn = async (data, user) => {
  const { employeeId, punchTime, punchSource = 'BIOMETRIC_SYNC', remarks } = data
  
  if (!employeeId) {
    throw new AppError('employeeId is required', 400)
  }
  
  // Parse punch time or use current time
  const punchDate = punchTime ? new Date(punchTime) : new Date()
  
  // ── 0. Fetch CompanyConfig for timezone ───────────────────────
  const companyConfig = await CompanyConfig.findOne({ org_id: user.orgId, company_id: user.companyId })
    .select('timezone overtimeThresholdHours overtimeEnabled halfDayThresholdHours')
    .lean()
  
  const timezone = companyConfig?.timezone || 'Asia/Kolkata'
  
  // ── 1. Get employee by ID (not from user token) ────────────────
  const employee = await Employee.findOne({
    _id: employeeId,
    org_id: user.orgId,
    company_id: user.companyId,
    isDeleted: false
  }).populate('unit_id', 'name geolocation locationSettings')
  
  if (!employee) {
    throw new AppError(`Employee not found: ${employeeId}`, 404)
  }
  
  // Use employee's unit
  const unitId = employee.unit_id?._id || employee.unit_id
  const unit = employee.unit_id
  
  // ── 2. Get date based on punch time (org timezone midnight) ────
  // Get the date in org timezone
  const orgPunchTime = new Date(punchDate.toLocaleString('en-US', { timeZone: timezone }))
  // Create date at UTC midnight on the org date
  // This ensures all attendance for the same org day have identical dates for querying
  const today = new Date(orgPunchTime)
  today.setUTCHours(0, 0, 0, 0)
  
  // ── 3. Use unit location for biometric punches ──────────────────
  let capturedLocation = null
  if (unit?.geolocation?.latitude && unit?.geolocation?.longitude) {
    capturedLocation = {
      latitude: unit.geolocation.latitude,
      longitude: unit.geolocation.longitude,
      accuracy: unit.geolocation.radiusMeters || 200,
      source: 'unit_default',
      message: `Biometric sync - using unit "${unit.name}" location`
    }
  }
  
  // ── 4. Check existing attendance ───────────────────────────────
  const existing = await Attendance.findOne({
    org_id: user.orgId,
    company_id: user.companyId,
    employeeId: employee._id,
    date: today
  })
  
  if (existing?.checkIn && !existing.checkOut) {
    // Already punched in, update punch-out instead
    return {
      alreadyPunchedIn: true,
      record: existing,
      message: `Employee already punched in at ${existing.checkIn}`
    }
  }
  
  if (existing?.checkIn && existing?.checkOut) {
    // Already completed, skip
    return {
      alreadyCompleted: true,
      record: existing,
      message: 'Attendance already completed for this date'
    }
  }
  
  // ── 5. Employee active check ──────────────────────────────────
  if (employee.status !== 'ACTIVE') {
    throw new AppError(`Cannot punch-in for inactive employee (status: ${employee.status})`, 403)
  }
  
  // ── 6. Holiday & Leave check ────────────────────────────────
  const holiday = await Holiday.findOne({
    org_id: user.orgId,
    company_id: user.companyId,
    // For unit-level employees, check unit-specific holiday or company-wide holiday
    ...(user.unitId && { $or: [{ unit_id: user.unitId }, { unit_id: null }] }),
    date: { $gte: today, $lt: new Date(today.getTime() + 86400000) },
    isDeleted: false
  }).select('name type').lean()
  
  const approvedLeave = await LeaveRequest.findOne({
    employeeId: employee._id,
    status: 'APPROVED',
    startDate: { $lte: today },
    endDate: { $gte: today }
  }).select('leaveTypeId').lean()
  
  // ── 7. Resolve shift dynamically ─────────────────────────────
  let shiftStart = '09:00'
  let shiftEnd = '18:00'
  let isNextDay = false
  let graceMinutes = 15
  let standardHours = 8
  let halfDayThreshold = 4
  let shiftId = null
  let shiftSource = 'policy_default'
  let resolvedShiftId = null
  let resolvedRosterId = null
  
  try {
    const shiftResult = await resolveShiftForEmployee(
      employee._id,
      unitId,
      user.orgId,
      user.companyId,
      today
    )
    
    if (shiftResult?.shift) {
      const s = shiftResult.shift
      shiftStart = s.startTime
      shiftEnd = s.endTime
      isNextDay = s.isNextDay ?? false
      graceMinutes = s.gracePeriodMinutes ?? 15
      standardHours = (s.workingMinutes ?? 480) / 60
      halfDayThreshold = (s.halfDayThresholdMinutes ?? 240) / 60
      shiftId = s._id
      shiftSource = shiftResult.source
      resolvedShiftId = s._id
      resolvedRosterId = shiftResult.roster_id || null
    }
  } catch (_) {
    // Fall through to policy
  }
  
  // AttendancePolicy fallback
  const attendancePolicy = await resolveAttendancePolicy(
    employee._id.toString(),
    user.companyId.toString(),
    unitId ? unitId.toString() : null
  )
  
  if (shiftSource === 'policy_default' && attendancePolicy) {
    shiftStart = attendancePolicy.shift?.start ?? '09:00'
    shiftEnd = attendancePolicy.shift?.end ?? '18:00'
    isNextDay = attendancePolicy.shift?.isNextDay ?? false
    graceMinutes = attendancePolicy.shift?.graceMinutes ?? 15
    standardHours = attendancePolicy.shift?.minimumHours ?? 8
    halfDayThreshold = attendancePolicy.shift?.halfDayMinHours ?? 4
    shiftSource = 'policy'
  }
  
  const overtimeThreshold = companyConfig?.overtimeThresholdHours ?? 0
  
  // ── 8. Determine late status ──────────────────────────────────
  const punchInStatus = getPunchInStatus(punchDate, shiftStart, graceMinutes, timezone)
  const isLate = punchInStatus === 'LATE'
  const lateMinutes = isLate ? Math.ceil((punchDate - new Date(punchDate.toDateString() + ' ' + shiftStart.replace('24:', '00:'))) / (1000 * 60)) : 0
  
  // ── 9. Determine status ──────────────────────────────────────
  // IMPORTANT: If employee punches in, status reflects attendance, NOT holiday
  // Holiday status is only for auto-generated records when no one punches in
  let status = 'PRESENT'
  if (approvedLeave) status = 'ON_LEAVE'
  if (isLate) status = 'LATE'
  
  // ── 10. Create attendance record ─────────────────────────────
  const record = await Attendance.findOneAndUpdate(
    {
      org_id: user.orgId,
      company_id: user.companyId,
      unit_id: unitId,
      employeeId: employee._id,
      date: today
    },
    {
      $setOnInsert: {
        org_id: user.orgId,
        company_id: user.companyId,
        unit_id: unitId,
        employeeId: employee._id,
        userId: employee.userId,
        date: today,
        standardHours,
        shiftStart,
        shiftEnd,
        graceMinutes,
        isNextDay,
        shiftId: resolvedShiftId || null,
        rosterId: resolvedRosterId || null,
        shiftSource,
        halfDayThreshold,
        overtimeThreshold,
        createdBy: user.userId
      },
      $set: {
        checkIn: punchDate,
        status,
        isLate,
        lateMinutes,
        punchSource,
        remarks: remarks || `Biometric sync - ${punchSource}`,
        updatedBy: user.userId,
        ...(capturedLocation && {
          checkInLocation: {
            latitude: capturedLocation.latitude,
            longitude: capturedLocation.longitude,
            accuracy: capturedLocation.accuracy,
            timestamp: punchDate,
            isValid: true,
            source: capturedLocation.source,
            message: capturedLocation.message
          }
        })
      }
    },
    { upsert: true, new: true }
  )
  
  return { created: true, record }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN PUNCH-OUT (Biometric Sync Helper)
// POST /hrms/attendance/admin/punch-out
// Called by biometric sync to punch-out on behalf of employee
// ─────────────────────────────────────────────────────────────────────────────
exports.adminPunchOut = async (data, user) => {
  const { employeeId, punchTime, punchSource = 'BIOMETRIC_SYNC', remarks } = data
  
  if (!employeeId) {
    throw new AppError('employeeId is required', 400)
  }
  
  const punchDate = punchTime ? new Date(punchTime) : new Date()
  
  // ── 0. Fetch CompanyConfig for timezone ───────────────────────
  const companyConfig = await CompanyConfig.findOne({ org_id: user.orgId, company_id: user.companyId })
    .select('timezone overtimeThresholdHours overtimeEnabled halfDayThresholdHours')
    .lean()
  
  const timezone = companyConfig?.timezone || 'Asia/Kolkata'
  
  // ── 1. Get employee ──────────────────────────────────────────
  const employee = await Employee.findOne({
    _id: employeeId,
    org_id: user.orgId,
    company_id: user.companyId,
    isDeleted: false
  }).populate('unit_id', 'name geolocation')
  
  if (!employee) {
    throw new AppError(`Employee not found: ${employeeId}`, 404)
  }
  
  const unitId = employee.unit_id?._id || employee.unit_id
  const unit = employee.unit_id
  
  // ── 2. Get date based on punch time ───────────────────────────
  // Get the date in org timezone
  const orgPunchTime = new Date(punchDate.toLocaleString('en-US', { timeZone: timezone }))
  // Create date at UTC midnight on the org date
  // This ensures all attendance for the same org day have identical dates for querying
  const today = new Date(orgPunchTime)
  today.setUTCHours(0, 0, 0, 0)
  
  // ── 3. Find attendance record ────────────────────────────────
  const record = await Attendance.findOne({
    org_id: user.orgId,
    company_id: user.companyId,
    employeeId: employee._id,
    date: today
  })
  
  // ── 4. Validation ────────────────────────────────────────────
  if (!record || !record.checkIn) {
    // No existing punch-in - can't punch out without punch-in
    throw new AppError('No punch-in found for this date. Punch-in first.', 400)
  }
  
  if (record.checkOut) {
    return {
      alreadyCompleted: true,
      record,
      message: 'Already punched out for this date'
    }
  }
  
  // ── 5. Punch-out can't be before punch-in ────────────────────
  if (punchDate < record.checkIn) {
    throw new AppError('Punch-out time cannot be before punch-in time', 400)
  }
  
  // ── 6. Calculate working hours ───────────────────────────────
  const workingHours = calculateWorkingHours(record.checkIn, punchDate, timezone)
  
  const detectedOvertimeHours = calculateOvertime(
    punchDate,
    record.shiftEnd,
    record.isNextDay,
    record.date,
    timezone,
    0
  )
  const overtimeHours = calculatePolicyOvertime(
    detectedOvertimeHours,
    attendancePolicy.overtime
  )
  
  // ── 7. Use unit location ─────────────────────────────────────
  let capturedLocation = null
  if (unit?.geolocation?.latitude && unit?.geolocation?.longitude) {
    capturedLocation = {
      latitude: unit.geolocation.latitude,
      longitude: unit.geolocation.longitude,
      accuracy: unit.geolocation.radiusMeters || 200,
      source: 'unit_default',
      message: `Biometric sync - using unit "${unit.name}" location`
    }
  }
  
  // ── 8. Update attendance ──────────────────────────────────────
  record.checkOut = punchDate
  record.workingHours = workingHours
  record.overtimeHours = overtimeHours
  record.punchSource = punchSource
  record.updatedBy = user.userId
  if (remarks) record.remarks = remarks
  
  // Update status based on working hours
  const halfDayMin = record.halfDayThreshold || 4
  const fullDayMin = record.standardHours || 8
  
  if (['PRESENT', 'WFH', 'LATE'].includes(record.status)) {
    if (workingHours < halfDayMin) {
      record.status = 'ABSENT'
    } else if (workingHours >= halfDayMin && workingHours < fullDayMin) {
      record.status = 'HALF_DAY'
    }
  }
  
  // Add check-out location
  if (capturedLocation) {
    record.checkOutLocation = {
      latitude: capturedLocation.latitude,
      longitude: capturedLocation.longitude,
      accuracy: capturedLocation.accuracy,
      timestamp: punchDate,
      isValid: true,
      source: capturedLocation.source,
      message: capturedLocation.message
    }
  }
  
  await record.save()
  
  return { updated: true, record }
}