// modules/biometric/biometric.service.js
// Biometric Device Integration Service
//
// Orchestrates adapter calls, stores config, manages sync.
// Always uses adapter abstraction - never calls SOAP directly.
//
// Scope: UNIT-LEVEL (org_id + company_id + unit_id)

const BiometricConfig    = require('./models/biometricConfig.model');
const BiometricCommand   = require('./models/biometricCommand.model');
const BiometricSyncLog   = require('./models/biometricSyncLog.model');
const BiometricMapping   = require('./models/biometricMapping.model');
const BiometricCounter   = require('./models/biometricCounter.model');
const Employee           = require('../employee/models/employee.model');
const Attendance         = require('../attendance/models/attendance.model');
const AppError          = require('../../utils/appError');
const { createAdapter } = require('./adapters/biometricAdapter.interface');
const CompanyConfig      = require('../companyConfig/models/companyConfig.model');
const moment             = require('moment-timezone');
const { resolveIsNextDay } = require('../../utils/timezone');

// ─── Build Scope Filter ───────────────────────────────────────────────
const buildScopeFilter = (user) => {
  const filter = { 
    org_id:     user.orgId,
    company_id: user.companyId 
  };

  // Unit admin/manager only sees their unit
  if (user.level === 'unit') {
    filter.unit_id = user.unitId;
  }

  return filter;
};

// ─── Get/Decrypt Config Credentials ─────────────────────────────────────
const getDecryptedConfig = async (configId) => {
  const config = await BiometricConfig.findById(configId).select('+password +apiKey');
  if (!config) throw new AppError('Biometric config not found', 404);
  
  // Decrypt happens via schema getters when accessing
  return {
    serverUrl: config.serverUrl,
    apiKey:    config.apiKey,    // Already decrypted by getter
    username:  config.username,
    password:  config.password,  // Already decrypted by getter
    vendor:    config.vendor
  };
};

// ─── CREATE CONFIG (Unit-scoped) ─────────────────────────────────────────
exports.createConfig = async (payload, user) => {
  // Validate biometric config requirements
  if (payload.biometricEnabled) {
    if (!payload.serverUrl) {
      throw new AppError('Server URL is required when biometric is enabled', 400);
    }
    if (!payload.username) {
      throw new AppError('Username is required when biometric is enabled', 400);
    }
    if (!payload.password) {
      throw new AppError('Password is required when biometric is enabled', 400);
    }
  }
  
  // Validate unit belongs to user's scope
  const scopeFilter = buildScopeFilter(user);
  
  // Check if config already exists for this unit
  const existing = await BiometricConfig.findOne({
    ...scopeFilter,
    unit_id: payload.unit_id
  });

  if (existing) {
    throw new AppError('Biometric config already exists for this unit', 409);
  }

  // Create config
  const config = await BiometricConfig.create({
    ...payload,
    org_id:     user.orgId,
    company_id: user.companyId,
    createdBy:  user._id
  });

  return config.toObject({ getters: true });
};

// ─── UPDATE CONFIG ───────────────────────────────────────────────────────
exports.updateConfig = async (configId, updates, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  // Find and validate scope
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }

  // Allowed updates
  const allowedUpdates = [
    'biometricEnabled', 'serverUrl', 'apiKey', 'username', 'password',
    'devices', 'syncIntervalMinutes'
  ];

  allowedUpdates.forEach(field => {
    if (updates[field] !== undefined && (!['apiKey', 'password'].includes(field) || updates[field] !== '')) {
      config[field] = updates[field];
    }
  });

  config.updatedBy = user._id;
  await config.save();

  return config.toObject({ getters: true });
};

// ─── GET CONFIG ──────────────────────────────────────────────────────────
exports.getConfig = async (user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    ...scopeFilter,
    isDeleted: false
  });

  if (!config) return null;

  // Don't expose encrypted credentials in response
  const result = config.toObject({ getters: true });
  delete result.apiKey;
  delete result.password;

  return result;
};

// ─── TEST SERVER CONNECTION ─────────────────────────────────────────────────
exports.testServerConnection = async (configId, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false
  }).select('+password +apiKey').lean({ getters: true });

  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }

  console.log('[DEBUG] Config loaded:', {
    serverUrl: config.serverUrl,
    hasUsername: !!config.username,
    hasPassword: !!config.password,
    hasApiKey: !!config.apiKey
  });

  if (!config.serverUrl || !config.username || !config.password) {
    throw new AppError('Server URL, username, and password are required', 400);
  }

  const adapter = createAdapter(config.vendor || 'ESSL', {
    serverUrl: config.serverUrl,
    apiKey:    config.apiKey || null,
    username:  config.username,
    password:  config.password
  });
  
  try {
    // Test the connection
    const testResult = await adapter.testConnection();

    if (!testResult.success) {
      throw new AppError(testResult.error || 'Connection test failed', 502);
    }

    const testedAt = new Date();
    await BiometricConfig.updateOne(
      { _id: configId },
      { $set: { connectionStatus: 'ONLINE', lastTestedAt: testedAt, lastError: null } }
    );

    return {
      status: 'ONLINE',
      message: 'Server connection successful',
      serverUrl: config.serverUrl,
      testedAt
    };
  } catch (err) {
    // Update config with error status
    await BiometricConfig.updateOne(
      { _id: configId },
      { $set: { connectionStatus: 'ERROR', lastTestedAt: new Date(), lastError: err.message } }
    );

    throw new AppError(`Server connection failed: ${err.message}`, 502);
  }
};

// ─── ADD DEVICE ───────────────────────────────────────────────────────────
exports.addDevice = async (configId, deviceData, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }

  try {
    config.addDevice(deviceData);
    await config.save();
    return config.devices[config.devices.length - 1];
  } catch (err) {
    throw new AppError(err.message, 400);
  }
};

// ─── UPDATE DEVICE ─────────────────────────────────────────────────────────
exports.updateDevice = async (configId, serialNumber, updates, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }

  try {
    config.updateDevice(serialNumber, updates);
    await config.save();
    return config.getDevice(serialNumber);
  } catch (err) {
    throw new AppError(err.message, 404);
  }
};

// ─── REMOVE DEVICE ─────────────────────────────────────────────────────────
exports.removeDevice = async (configId, serialNumber, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }

  config.removeDevice(serialNumber);
  await config.save();

  return { message: 'Device removed successfully' };
};

// ─── TEST DEVICE CONNECTION ───────────────────────────────────────────────
exports.testConnection = async (configId, serialNumber, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false
  }).select('+password +apiKey');

  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }

  const device = config.getDevice(serialNumber);
  if (!device) {
    throw new AppError('Device not found', 404);
  }

  // Get decrypted credentials (password/apiKey are decrypted via schema getters)
  const credentials = {
    serverUrl: config.serverUrl,
    apiKey:    config.apiKey,
    username:  config.username,
    password:  config.password,
    vendor:    config.vendor
  };
  
  // Create adapter
  const adapter = createAdapter(config.vendor, credentials);

  // Test connection
  const result = await adapter.testConnection();

  // Update device status
  device.connectionStatus = result.success ? 'ONLINE' : 'OFFLINE';
  device.lastPingAt       = new Date();
  await config.save();

  return result;
};

// ─── PUSH EMPLOYEE TO DEVICE ──────────────────────────────────────────────
exports.pushEmployeeToDevice = async (configId, employeeId, serialNumber, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  // Get config
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false,
    biometricEnabled: true
  });

  if (!config) {
    throw new AppError('Biometric not enabled for this unit', 400);
  }

  const device = config.getDevice(serialNumber);
  if (!device) {
    throw new AppError('Device not found', 404);
  }

  // Get employee
  const employee = await Employee.findOne({
    _id:       employeeId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!employee) {
    throw new AppError('Employee not found', 404);
  }

  // Minimum biometricCode is 1001 (4-digit requirement for eSSL devices)
  const MIN_BIOMETRIC_CODE = 1001;

  // Generate biometricCode if not exists or too low
  let biometricCode = employee.biometricCode;
  if (!biometricCode || biometricCode < MIN_BIOMETRIC_CODE) {
    // Use atomic counter to prevent race conditions
    biometricCode = await getNextBiometricCode(config.unit_id);
    employee.biometricCode = biometricCode;
    await employee.save();
  }

  // Create adapter
  const credentials = await getDecryptedConfig(config._id);
  const adapter     = createAdapter(config.vendor, credentials);

  // Push to device
  const result = await adapter.pushEmployee({
    employeeCode: biometricCode,
    name:         employee.name,
    cardNumber:   employee.rfidCardNumber
  }, serialNumber);

  // Track command
  if (result.success && result.commandId) {
    try {
      await BiometricCommand.create({
        org_id:                  user.orgId,
        company_id:               user.companyId,
        unit_id:                  user.unitId || config.unit_id,
        commandId:                String(result.commandId),
        type:                     'ADD_EMPLOYEE',
        employeeId:               employee._id,
        biometricCode:            biometricCode,
        deviceSerialNumber:       serialNumber
      });
    } catch (cmdErr) {
      console.error('[BiometricService] Failed to track command:', cmdErr);
      // Don't fail the request if tracking fails
    }
  }

  return result;
};

// ─── GET NEXT BIOMETRIC CODE (Atomic) ───────────────────────────────────────
// Atomically returns the next valid biometric code for a unit
// Ensures code is >= 1001 (4-digit minimum for eSSL devices)
const getNextBiometricCode = async (unitId) => {
  const MIN_CODE = 1001;
  
  // First check highest existing code in employees collection
  const highestEmployee = await Employee.findOne({
    unit_id: unitId,
    biometricCode: { $exists: true, $ne: null, $gte: MIN_CODE }
  }).sort({ biometricCode: -1 }).lean();
  
  // Determine next code
  let nextCode = MIN_CODE;
  if (highestEmployee?.biometricCode && highestEmployee.biometricCode >= MIN_CODE) {
    nextCode = highestEmployee.biometricCode + 1;
  }
  
  // Atomic increment with conflict prevention
  const counter = await BiometricCounter.findOneAndUpdate(
    { unit_id: unitId },
    { $max: { sequenceValue: nextCode } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  
  // Increment by 1 and return
  const finalCounter = await BiometricCounter.findOneAndUpdate(
    { unit_id: unitId },
    { $inc: { sequenceValue: 1 } },
    { new: true }
  );
  
  return finalCounter.sequenceValue;
};

// ─── ENROLL FINGERPRINT ───────────────────────────────────────────────────
exports.enrollFingerprint = async (configId, serialNumber, payload, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false,
    biometricEnabled: true
  }).select('+password +apiKey');

  if (!config) {
    throw new AppError('Biometric not enabled for this unit', 404);
  }

  const device = config.getDevice(serialNumber);
  if (!device) {
    throw new AppError('Device not found', 404);
  }

  if (!payload.employeeCode) {
    throw new AppError('employeeCode is required', 400);
  }

  if (payload.fingerIndex === undefined || payload.fingerIndex < 0 || payload.fingerIndex > 9) {
    throw new AppError('fingerIndex is required and must be 0-9', 400);
  }

  // Create adapter
  const credentials = {
    serverUrl: config.serverUrl,
    apiKey:    config.apiKey,
    username:  config.username,
    password:  config.password,
    vendor:    config.vendor
  };
  const adapter = createAdapter(config.vendor, credentials);

  // Enroll fingerprint
  const result = await adapter.enrollFingerprint({
    deviceSerialNumber: serialNumber,
    employeeCode:       payload.employeeCode,
    fingerIndex:        payload.fingerIndex,
    overwrite:          payload.isOverWrite !== false
  });

  // Track command
  if (result.success && result.commandId) {
    await BiometricCommand.create({
      org_id:                user.orgId,
      company_id:             user.companyId,
      unit_id:                user.unitId || config.unit_id,
      commandId:              result.commandId,
      type:                   'ENROLL_FINGERPRINT',
      biometricCode:          payload.employeeCode,
      deviceSerialNumber:     serialNumber
    });
  }

  return result;
};

// ─── ENROLL FACE ───────────────────────────────────────────────────────────
exports.enrollFace = async (configId, serialNumber, payload, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false,
    biometricEnabled: true
  }).select('+password +apiKey');

  if (!config) {
    throw new AppError('Biometric not enabled for this unit', 404);
  }

  const device = config.getDevice(serialNumber);
  if (!device) {
    throw new AppError('Device not found', 404);
  }

  if (!payload.employeeCode) {
    throw new AppError('employeeCode is required', 400);
  }

  // Create adapter
  const credentials = {
    serverUrl: config.serverUrl,
    apiKey:    config.apiKey,
    username:  config.username,
    password:  config.password,
    vendor:    config.vendor
  };
  const adapter = createAdapter(config.vendor, credentials);

  // Enroll face
  const result = await adapter.enrollFace({
    deviceSerialNumber: serialNumber,
    employeeCode:       payload.employeeCode,
    overwrite:          payload.isOverWrite !== false
  });

  // Track command
  if (result.success && result.commandId) {
    await BiometricCommand.create({
      org_id:                user.orgId,
      company_id:             user.companyId,
      unit_id:                user.unitId || config.unit_id,
      commandId:              result.commandId,
      type:                   'ENROLL_FACE',
      biometricCode:          payload.employeeCode,
      deviceSerialNumber:     serialNumber
    });
  }

  return result;
};

// ─── PULL ATTENDANCE FROM DEVICE ───────────────────────────────────────────
exports.pullAttendanceFromDevice = async (configId, serialNumber, options, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  // Get config
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false,
    biometricEnabled: true
  });

  if (!config) {
    throw new AppError('Biometric not enabled for this unit', 404);
  }

  const device = config.getDevice(serialNumber);
  if (!device) {
    throw new AppError('Device not found', 404);
  }

  // ─── PRE-SYNC CONNECTIVITY CHECK ─────────────────────────────────────────
  // Validate device is reachable before attempting sync
  // This prevents "ECONNREFUSED" errors when device goes offline between tests
  try {
    const credentials = await getDecryptedConfig(config._id);
    const adapter     = createAdapter(config.vendor, credentials);
    
    // Quick connection test before sync
    const connectivityResult = await adapter.testConnection();
    
    if (!connectivityResult.success) {
      // Update device status immediately
      device.connectionStatus = 'OFFLINE';
      device.lastError = connectivityResult.error;
      await config.save();
      
      throw new AppError(
        `Device offline: ${connectivityResult.error || 'Connection refused'}. ` +
        `IP: ${config.serverUrl}. Please check network connectivity.`,
        503
      );
    }
    
    // Device is reachable, update status
    device.connectionStatus = 'ONLINE';
    device.lastPingAt = new Date();
    await config.save();
    
  } catch (connErr) {
    // Re-throw AppError instances
    if (connErr instanceof AppError) throw connErr;
    
    // Wrap network errors
    throw new AppError(
      `Network error: ${connErr.message}. Device may be offline or unreachable. ` +
      `Server: ${config.serverUrl}`,
      503
    );
  }

  // Create sync log
  const syncLog = await BiometricSyncLog.create({
    org_id:              user.orgId,
    company_id:           user.companyId,
    unit_id:              user.unitId || config.unit_id,
    deviceSerialNumber:   serialNumber,
    syncType:            options.isManual ? 'MANUAL' : 'SCHEDULED',
    status:              'RUNNING',
    triggeredBy:         user._id
  });

  try {
    // Create adapter (reuse credentials from above)
    const credentials = await getDecryptedConfig(config._id);
    const adapter     = createAdapter(config.vendor, credentials);

    // Determine time range
    const fromDateTime = options?.startTime || new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: last 24h
    const toDateTime   = options?.endTime || new Date();

    // Pull transactions - pass serialNumber and date params correctly
    const result = await adapter.pullTransactions({
      deviceSerialNumber: serialNumber,
      fromDateTime,
      toDateTime
    });

    if (!result.success) {
      syncLog.status = 'FAILED';
      syncLog.errorMessage = result.error;
      syncLog.completedAt = new Date();
      await syncLog.save();
      return result;
    }

    // Process records
    const processedResult = await processPunchRecords(
      result.records,
      config,
      device,
      user
    );

    // Update device sync status
    device.lastSyncedAt       = new Date();
    device.lastSyncedRecordId = result.lastRecordId || device.lastSyncedRecordId;
    await config.save();

    // Complete sync log
    await syncLog.complete({
      status:            processedResult.failedCount === 0 ? 'SUCCESS' : 'PARTIAL',
      recordsFetched:    result.records.length,
      recordsProcessed:  processedResult.processedCount,
      recordsMatched:    processedResult.matchedCount,
      recordsUnmatched:  processedResult.unmatchedCount,
      lastRecordId:      result.lastRecordId,
      unmatchedRecords:  processedResult.unmatchedRecords.slice(0, 100) // Limit to 100
    });

    return {
      success: true,
      syncLogId: syncLog._id,
      recordsFetched: processedResult.matchedRecords.reduce((count, record) => count + record.totalPunches, 0),
      recordsMatched: processedResult.matchedCount,
      recordsCreated: processedResult.createdCount,
      recordsUpdated: processedResult.updatedCount,
      unmatchedCount: 0,
      // Pagination metadata
      pagination: {
        matchedTotal: processedResult.matchedRecords.length,
        unmatchedTotal: 0,
        matchedReturned: Math.min(50, processedResult.matchedRecords.length),
        unmatchedReturned: 0
      },
      // Auto-created attendance records (matched)
      matchedRecords: processedResult.matchedRecords.slice(0, 50),
      unmatchedRecords: []
    };

  } catch (error) {
    syncLog.status       = 'FAILED';
    syncLog.errorMessage = error.message;
    syncLog.errorStack    = error.stack;
    syncLog.completedAt  = new Date();
    await syncLog.save();

    throw error;
  }
};

// ─── PROCESS PUNCH RECORDS ────────────────────────────────────────────────
// Groups punches by employee, finds first (checkIn) and last (checkOut) punch
// Returns unique records per employee per day
const processPunchRecords = async (records, config, device, user) => {
  const result = {
    processedCount: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    createdCount: 0,
    updatedCount: 0,
    failedCount: 0,
    unmatchedRecords: [],
    matchedRecords: []
  };

  // ─── STEP 1: Group punches by employeeCode ───────────────────────────────
  const punchesByEmployee = {};
  
  for (const record of records) {
    const code = record.employeeCode;
    if (!punchesByEmployee[code]) {
      punchesByEmployee[code] = [];
    }
    punchesByEmployee[code].push({
      punchTime: new Date(record.punchTime),
      punchType: record.punchType
    });
  }

  // ─── STEP 2: Process each unique employee ────────────────────────────────
  for (const [employeeCode, punches] of Object.entries(punchesByEmployee)) {
    try {
      // Sort punches by time (earliest first)
      punches.sort((a, b) => a.punchTime - b.punchTime);
      
      const firstPunch = punches[0];
      const lastPunch = punches[punches.length - 1];
      const punchDate = new Date(firstPunch.punchTime);
      punchDate.setUTCHours(0, 0, 0, 0);

      // Find employee with full profile
      const employee = await Employee.findOne({
        biometricCode: parseInt(employeeCode),
        org_id: config.org_id,
        company_id: config.company_id,
        unit_id: config.unit_id,
        isDeleted: false
      }).populate('departmentId', 'name')
        .populate('designationId', 'name')
        .populate('reportingManagerId', 'fullName');

      if (!employee) {
        // Check mapping
        const mapping = await BiometricMapping.findOne({
          biometricCode: employeeCode,
          org_id: config.org_id,
          company_id: config.company_id,
          unit_id: config.unit_id,
          deviceSerialNumber: device.serialNumber,
          status: 'ACTIVE',
          isVerified: true,
          isDeleted: false
        }).populate({
          path: 'employeeId',
          match: {
            org_id: config.org_id,
            company_id: config.company_id,
            unit_id: config.unit_id,
            isDeleted: false
          },
          populate: [
            { path: 'departmentId', select: 'name' },
            { path: 'designationId', select: 'name' },
            { path: 'reportingManagerId', select: 'fullName' }
          ]
        });

        if (mapping && mapping.employeeId) {
          result.matchedCount++;
          
          const attendanceResult = await updateAttendanceFromPunchWithTimes(
            mapping.employeeId,
            firstPunch.punchTime,
            lastPunch.punchTime,
            config,
            user
          );

          result.matchedRecords.push({
            employeeCode,
            employeeId: mapping.employeeId._id,
            employeeName: mapping.employeeId.fullName,
            employeeEmail: mapping.employeeId.email || 'N/A',
            employeePhoto: mapping.employeeId.profilePhoto || null,
            department: mapping.employeeId.departmentId?.name || 'N/A',
            designation: mapping.employeeId.designationId?.name || 'N/A',
            reportingManager: mapping.employeeId.reportingManagerId?.fullName || 'N/A',
            date: punchDate,
            firstPunch: firstPunch.punchTime,
            lastPunch: lastPunch.punchTime,
            checkIn: attendanceResult?.attendance?.checkIn,
            checkOut: attendanceResult?.attendance?.checkOut,
            totalPunches: punches.length,
            workingHours: attendanceResult?.attendance?.workingHours || 0,
            status: attendanceResult?.attendance?.status || 'PRESENT',
            created: attendanceResult?.created || false
          });

          if (attendanceResult?.created) result.createdCount++;
          else if (attendanceResult?.updated) result.updatedCount++;

          result.processedCount++;
          continue;
        }

        // Unmapped
        result.unmatchedCount++;
        result.unmatchedRecords.push({
          employeeCode,
          punchTime: firstPunch.punchTime,
          lastPunchTime: lastPunch.punchTime,
          totalPunches: punches.length,
          message: 'Employee not found with this biometric code'
        });
        continue;
      }

      // Matched employee
      result.matchedCount++;
      
      const attendanceResult = await updateAttendanceFromPunchWithTimes(
        employee,
        firstPunch.punchTime,
        lastPunch.punchTime,
        config,
        user
      );

      result.matchedRecords.push({
        employeeCode,
        employeeId: employee._id,
        employeeName: employee.fullName,
        employeeEmail: employee.email || 'N/A',
        employeePhoto: employee.profilePhoto || null,
        department: employee.departmentId?.name || 'N/A',
        designation: employee.designationId?.name || 'N/A',
        reportingManager: employee.reportingManagerId?.fullName || 'N/A',
        date: punchDate,
        firstPunch: firstPunch.punchTime,
        lastPunch: lastPunch.punchTime,
        checkIn: attendanceResult?.attendance?.checkIn,
        checkOut: attendanceResult?.attendance?.checkOut,
        totalPunches: punches.length,
        workingHours: attendanceResult?.attendance?.workingHours || 0,
        status: attendanceResult?.attendance?.status || 'PRESENT',
        created: attendanceResult?.created || false
      });

      if (attendanceResult?.created) result.createdCount++;
      else if (attendanceResult?.updated) result.updatedCount++;

      result.processedCount++;

    } catch (err) {
      console.error(`[BiometricService] Error processing employee ${employeeCode}:`, err.message);
      result.failedCount++;
    }
  }

  // Sort matched records by first punch time (latest first)
  result.matchedRecords.sort((a, b) => new Date(b.firstPunch) - new Date(a.firstPunch));

  return result;
};

// ─── UPDATE ATTENDANCE FROM PUNCH WITH TIMES ────────────────────────────────
// Creates/updates attendance with firstPunch as checkIn
// IMPORTANT: Does NOT set checkOut immediately after shift start
// checkOut will only be set by evening cron job after shift end
const updateAttendanceFromPunchWithTimes = async (employee, firstPunchTime, lastPunchTime, config, user) => {
  const checkInTime = new Date(firstPunchTime);
  const checkOutTime = new Date(lastPunchTime);
  
  // CRITICAL: Use org timezone to match attendance query logic
  // Attendance records use timezone-aware midnight for the 'date' field
  const companyConfig = await CompanyConfig.findOne({ 
    org_id: config.org_id, 
    company_id: config.company_id 
  }).select('timezone').lean();
  const timezone = companyConfig?.timezone || 'Asia/Kolkata';
  
  // Use timezone-aware start of day (same as attendance service)
  const startOfDay = moment(checkInTime).tz(timezone).startOf('day').toDate();

  // Get current time in org timezone
  const nowInOrg = moment().tz(timezone);

  // Find existing attendance for this employee on this date
  let attendance = await Attendance.findOne({
    employeeId: employee._id || employee,
    date: startOfDay,
    org_id: config.org_id,
    company_id: config.company_id
  });

  // Get employee's shift info
  const Shift = require('../shift/models/shift.model');
  const Unit = require('../unit/models/unit.model');
  
  let shiftEndTime = null;
  let isNextDayShift = false;
  
  // Try to get shift from attendance record first
  if (attendance && attendance.shiftEnd) {
    const [shiftEndH, shiftEndM] = attendance.shiftEnd.split(':').map(Number);
    shiftEndTime = moment(nowInOrg).set({ hour: shiftEndH, minute: shiftEndM, second: 0, millisecond: 0 });
    isNextDayShift = attendance.isNextDay || false;
  } else {
    // Try to get shift from unit's default shift
    const unit = await Unit.findOne({ _id: config.unit_id }).select('shiftConfig').lean();
    
    if (unit?.shiftConfig?.defaultShift) {
      const defaultShift = await Shift.findById(unit.shiftConfig.defaultShift).select('startTime endTime isNextDay').lean();
      
      if (defaultShift) {
        const [shiftEndH, shiftEndM] = defaultShift.endTime.split(':').map(Number);
        shiftEndTime = moment(nowInOrg).set({ hour: shiftEndH, minute: shiftEndM, second: 0, millisecond: 0 });
        isNextDayShift = resolveIsNextDay(defaultShift.startTime, defaultShift.endTime, defaultShift.isNextDay); // AT-04
      }
    }
  }
  
  // ─── DECISION: Should we set checkOut? ─────────────────────────────
  // Only set checkOut if:
  // 1. Current time is AFTER shift end time (shift has ended)
  // 2. lastPunchTime > firstPunchTime (valid punch out exists)
  
  let shouldSetCheckOut = false;
  
  if (shiftEndTime) {
    if (isNextDayShift) {
      shiftEndTime.add(1, 'day');
    }
    
    // Check if current time is after shift end
    if (nowInOrg.isAfter(shiftEndTime) && checkOutTime > checkInTime) {
      shouldSetCheckOut = true;
    }
  }

  if (!attendance) {
    // Create new attendance record
    attendance = await Attendance.create({
      employeeId: employee._id || employee,
      userId: employee.userId || employee._id || employee,
      date: startOfDay,
      checkIn: checkInTime,
      checkOut: shouldSetCheckOut ? checkOutTime : null,
      status: 'PRESENT',
      punchSource: shouldSetCheckOut ? 'BIOMETRIC_CLOSED' : 'BIOMETRIC',
      org_id: config.org_id,
      company_id: config.company_id,
      unit_id: config.unit_id
    });

    // Calculate working hours if checkOut exists
    if (attendance.checkOut) {
      const diffMs = new Date(attendance.checkOut) - new Date(attendance.checkIn);
      attendance.workingHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
      await attendance.save();
    }

    console.log(`[BiometricService] Created attendance for ${employee.employeeId || employee}, checkIn: ${checkInTime}, checkOut: ${attendance.checkOut || 'still working'}`);
    return { created: true, attendance };
  }

  // Attendance exists - update with new punch times
  attendance.checkIn = checkInTime;
  
  // Only update checkOut if shift has ended
  if (shouldSetCheckOut) {
    attendance.checkOut = checkOutTime;
    attendance.punchSource = 'BIOMETRIC_CLOSED';
    
    // Calculate working hours
    const diffMs = new Date(attendance.checkOut) - new Date(attendance.checkIn);
    attendance.workingHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
    
    console.log(`[BiometricService] Finalized attendance for ${employee.employeeId || employee}, workingHours: ${attendance.workingHours}`);
  } else {
    // Keep punchSource as BIOMETRIC (still working)
    attendance.punchSource = 'BIOMETRIC';
    console.log(`[BiometricService] Updated attendance for ${employee.employeeId || employee}, still working (shift not ended)`);
  }

  await attendance.save();
  return { created: false, updated: true, attendance };
};

// ─── GET SYNC LOG RECORDS (PAGINATED) ─────────────────────────────────────
exports.getSyncLogRecords = async (syncLogId, type, page, limit, user) => {
  const scopeFilter = buildScopeFilter(user);
  const skip = (page - 1) * limit;

  const syncLog = await BiometricSyncLog.findOne({
    _id: syncLogId,
    ...scopeFilter
  });

  if (!syncLog) {
    throw new AppError('Sync log not found', 404);
  }

  if (type === 'unmatched') {
    return {
      records: [],
      total: 0,
      page,
      totalPages: 0
    };
  }

  // For matched, fetch today's biometric attendance
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const attendances = await Attendance.find({
    org_id: scopeFilter.org_id,
    company_id: scopeFilter.company_id,
    unit_id: syncLog.unit_id,
    date: today,
    punchSource: { $in: ['BIOMETRIC', 'BIOMETRIC_CLOSED'] }
  })
  .populate('employeeId', 'employeeId fullName email biometricCode')
  .populate({
    path: 'employeeId',
    populate: [
      { path: 'departmentId', select: 'name' },
      { path: 'designationId', select: 'name' }
    ]
  })
  .sort({ checkIn: -1 })
  .skip(skip)
  .limit(limit);

  const total = await Attendance.countDocuments({
    org_id: scopeFilter.org_id,
    company_id: scopeFilter.company_id,
    unit_id: syncLog.unit_id,
    date: today,
    punchSource: { $in: ['BIOMETRIC', 'BIOMETRIC_CLOSED'] }
  });

  return {
    records: attendances.map(a => ({
      employeeId: a.employeeId?._id,
      employeeCode: a.employeeId?.biometricCode,
      employeeName: a.employeeId?.fullName,
      employeeEmail: a.employeeId?.email,
      department: a.employeeId?.departmentId?.name || 'N/A',
      designation: a.employeeId?.designationId?.name || 'N/A',
      punchTime: a.checkIn,
      checkIn: a.checkIn,
      checkOut: a.checkOut,
      status: a.status,
      workingHours: a.workingHours,
      created: true
    })),
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
};

const getVisibleSyncLog = (log) => ({
  ...log.toObject({ virtuals: false }),
  recordsFetched: log.recordsMatched,
  recordsProcessed: log.recordsMatched,
  recordsUnmatched: 0,
  recordsSkipped: 0,
  lastRecordId: null,
  unmatchedRecords: []
});

// ─── GET SYNC LOGS ──────────────────────────────────────────────────��──────
exports.getSyncLogs = async (unitId, options, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const logs = await BiometricSyncLog.find({
    ...scopeFilter,
    unit_id: unitId
  })
  .sort({ startedAt: -1 })
  .limit(options.limit || 20);

  return logs.map(getVisibleSyncLog);
};

// ─── GET SYNC LOG DETAILS ────────────────────────────────────────────────
exports.getSyncLogDetails = async (logId, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const log = await BiometricSyncLog.findOne({
    _id:           logId,
    ...scopeFilter
  });

  if (!log) {
    throw new AppError('Sync log not found', 404);
  }

  return getVisibleSyncLog(log);
};

// ─── GET DEVICE STATUS ────────────────────────────────────────────────────
exports.getDeviceStatus = async (configId, serialNumber, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }

  const device = config.getDevice(serialNumber);
  if (!device) {
    throw new AppError('Device not found', 404);
  }

  return {
    serialNumber:    device.serialNumber,
    name:            device.name,
    isActive:        device.isActive,
    syncEnabled:     device.syncEnabled,
    connectionStatus: device.connectionStatus,
    lastSyncedAt:    device.lastSyncedAt,
    lastPingAt:      device.lastPingAt
  };
};

// ─── DELETE EMPLOYEE FROM DEVICE ──────────────────────────────────────────
exports.deleteEmployeeFromDevice = async (configId, employeeId, serialNumber, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id:       configId,
    ...scopeFilter,
    isDeleted: false,
    biometricEnabled: true
  });

  if (!config) {
    throw new AppError('Biometric not enabled for this unit', 404);
  }

  const employee = await Employee.findOne({
    _id:       employeeId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!employee || !employee.biometricCode) {
    throw new AppError('Employee not found or not registered on device', 404);
  }

  const credentials = await getDecryptedConfig(config._id);
  const adapter     = createAdapter(config.vendor, credentials);

  const result = await adapter.deleteEmployee(employee.biometricCode, serialNumber);

  if (result.success && result.commandId) {
    await BiometricCommand.create({
      org_id:              user.orgId,
      company_id:           user.companyId,
      unit_id:              user.unitId || config.unit_id,
      commandId:            result.commandId,
      type:                 'DELETE_EMPLOYEE',
      employeeId:           employee._id,
      biometricCode:        employee.biometricCode,
      deviceSerialNumber:   serialNumber
    });
  }

  return result;
};

// ─── GET COMMANDS ──────────────────────────────────────────────────────────
exports.getCommands = async (unitId, options, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const commands = await BiometricCommand.find({
    ...scopeFilter,
    unit_id: unitId
  })
  .sort({ createdAt: -1 })
  .limit(options.limit || 50);

  return commands;
};

// ─── POLL COMMAND STATUS ──────────────────────────────────────────────────
exports.pollCommandStatus = async (commandId, user) => {
  // commandId is a string identifier (not ObjectId), query by commandId field
  const command = await BiometricCommand.findOne({ commandId, ...buildScopeFilter(user) });
  
  if (!command) {
    throw new AppError('Command not found', 404);
  }

  // Check scope
  if (user.level === 'unit') {
    if (String(command.unit_id) !== String(user.unitId)) {
      throw new AppError('Access denied', 403);
    }
  }

  // Get config
  const config = await BiometricConfig.findOne({
    org_id:     command.org_id,
    company_id: command.company_id,
    unit_id:    command.unit_id,
    isDeleted:  false
  });

  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }

  // Create adapter and poll
  const credentials = await getDecryptedConfig(config._id);
  const adapter    = createAdapter(config.vendor, credentials);

  const result = await adapter.getCommandStatus(command.commandId, command.deviceSerialNumber);

  // Update command
  await command.incrementAttempt();

  const deviceStatus = typeof result.status === 'string' ? result.status.trim().toUpperCase() : '';
  if (result.success && deviceStatus === 'SUCCESS') {
    await command.markSuccess(result.status);
  } else if (result.success && (deviceStatus === 'FAILED' || deviceStatus === 'FAILURE')) {
    await command.markFailed(result.status);
  }

  return command;
};

// ─── CREATE MANUAL MAPPING ─────────────────────────────────────────────────
exports.createMapping = async (payload, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  // Check if mapping already exists
  const existing = await BiometricMapping.findOne({
    deviceSerialNumber: payload.deviceSerialNumber,
    deviceEmployeeCode: payload.deviceEmployeeCode,
    isDeleted:          false
  });

  if (existing) {
    throw new AppError('Mapping already exists for this device employee code', 409);
  }

  const mapping = await BiometricMapping.create({
    ...payload,
    org_id:     user.orgId,
    company_id: user.companyId,
    unit_id:    user.unitId || payload.unit_id,
    createdBy:  user._id
  });

  return mapping;
};

// ─── GET MAPPINGS ──────────────────────────────────────────────────────────
exports.getMappings = async (unitId, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const mappings = await BiometricMapping.find({
    ...scopeFilter,
    unit_id: unitId,
    isDeleted: false
  })
  .populate('employeeId')
  .sort({ createdAt: -1 });

  return mappings;
};

// ─── VERIFY MAPPING ────────────────────────────────────────────────────────
exports.verifyMapping = async (mappingId, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const mapping = await BiometricMapping.findOne({
    _id:       mappingId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!mapping) {
    throw new AppError('Mapping not found', 404);
  }

  await mapping.verify(user._id);

  return mapping;
};

// ─── DELETE MAPPING ─────────────────────────────────────────────────────────
exports.deleteMapping = async (mappingId, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const mapping = await BiometricMapping.findOne({
    _id:       mappingId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!mapping) {
    throw new AppError('Mapping not found', 404);
  }

  await mapping.removeMapping();

  return { message: 'Mapping removed successfully' };
};

// ─── ASSIGN BIOMETRIC CODE TO EMPLOYEE ─────────────────────────────────────
// Used when sync finds unmatched records - allows admin to assign existing
// biometric code from device to an employee in HRMS
exports.assignBiometricCode = async (employeeId, biometricCode, user) => {
  const scopeFilter = buildScopeFilter(user);
  const MIN_BIOMETRIC_CODE = 1001;

  // Validate biometricCode
  const code = parseInt(biometricCode, 10);
  if (isNaN(code) || code < MIN_BIOMETRIC_CODE) {
    throw new AppError(`biometricCode must be >= ${MIN_BIOMETRIC_CODE}`, 400);
  }

  // Find employee within scope
  const employee = await Employee.findOne({
    _id:       employeeId,
    ...scopeFilter,
    isDeleted: false
  });

  if (!employee) {
    throw new AppError('Employee not found', 404);
  }

  // Check if employee already has biometricCode
  if (employee.biometricCode) {
    throw new AppError('Employee already has a biometric code assigned', 400);
  }

  // Check if biometricCode is already assigned to another employee
  const existingWithCode = await Employee.findOne({
    unit_id:       employee.unit_id,
    biometricCode: code,
    isDeleted:     false
  });

  if (existingWithCode) {
    throw new AppError(`Biometric code ${code} is already assigned to ${existingWithCode.name}`, 409);
  }

  // Assign the code
  employee.biometricCode = code;
  await employee.save();

  // Update BiometricCounter to prevent conflicts
  await BiometricCounter.findOneAndUpdate(
    { unit_id: employee.unit_id },
    { $max: { sequenceValue: code + 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return await Employee.findById(employee._id)
    .populate('departmentId', 'name')
    .populate('designationId', 'name')
    .populate('unit_id', 'name');
};

// ─── GET EMPLOYEES WITHOUT BIOMETRIC CODE ──────────────────────────────────
// Returns list of employees in unit who don't have biometricCode assigned
exports.getEmployeesWithoutBiometricCode = async (unitId, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  // For unit-level users, buildScopeFilter already adds unit_id
  // For org/company level users, add unit_id from parameter (convert to ObjectId)
  if (!scopeFilter.unit_id) {
    scopeFilter.unit_id = new mongoose.Types.ObjectId(unitId);
  }
  
  const filter = {
    ...scopeFilter,
    isDeleted:  false,
    status:     'ACTIVE',
    $or: [
      { biometricCode: null },
      { biometricCode: { $exists: false } }
    ]
  };

  console.log('[getEmployeesWithoutBiometricCode] Filter:', JSON.stringify(filter, null, 2));

  const employees = await Employee.find(filter)
    .select('name employeeId status departmentId designationId')
    .populate('departmentId', 'name')
    .populate('designationId', 'name')
    .sort({ name: 1 })
    .limit(100);

  console.log(`[getEmployeesWithoutBiometricCode] Found ${employees.length} employees`);

  return employees;
};

// ─── BULK PUSH ALL EMPLOYEES TO DEVICE ──────────────────────────────────
// Push all active employees without biometricCode to a device
exports.bulkPushEmployees = async (configId, serialNumber, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id: configId,
    ...scopeFilter,
    isDeleted: false
  });
  
  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }
  
  // Find device in config
  const device = config.devices.find(d => d.serialNumber === serialNumber);
  if (!device) {
    throw new AppError('Device not found in config', 404);
  }
  
  // Get all active employees without biometricCode
  const employees = await Employee.find({
    ...scopeFilter,
    isDeleted: false,
    status: 'ACTIVE',
    $or: [
      { biometricCode: null },
      { biometricCode: { $exists: false } }
    ]
  }).select('_id name employeeId biometricCode');
  
  if (employees.length === 0) {
    return {
      success: true,
      message: 'No employees to push',
      pushed: 0,
      total: 0,
      commandId: null
    };
  }
  
  // Create adapter
  const adapter = await createAdapter(config);
  
  // Increment and assign biometric codes
  const updates = [];
  const employeesToPush = [];
  
  for (const emp of employees) {
    // Get next biometric code
    const counter = await BiometricCounter.findOneAndUpdate(
      { unit_id: scopeFilter.unit_id || user.unitId },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    
    const biometricCode = counter.seq;
    
    // Update employee
    emp.biometricCode = biometricCode;
    await emp.save();
    
    employeesToPush.push({
      employeeCode: biometricCode,
      name: emp.name,
      cardNumber: emp.rfidCardNumber || undefined
    });
    
    updates.push({ employee: emp, biometricCode });
  }
  
  // Push to device using bulk operation
  console.log(`[BiometricService] Bulk pushing ${employeesToPush.length} employees to device ${serialNumber}`);
  
  const result = await adapter.pushMultipleEmployees(employeesToPush, serialNumber);
  
  // Save command
  const command = await BiometricCommand.create({
    ...scopeFilter,
    commandId: result.commandId || `bulk-${Date.now()}`,
    commandType: 'BULK_PUSH',
    deviceSerialNumber: serialNumber,
    status: result.success ? 'PENDING' : 'FAILED',
    requestData: { employees: employeesToPush.length },
    createdBy: user.userId
  });
  
  return {
    success: result.success,
    message: result.success ? `Bulk push initiated for ${employees.length} employees` : result.error,
    pushed: employees.length,
    total: employees.length,
    commandId: command.commandId,
    employees: updates.map(u => ({
      _id: u.employee._id,
      name: u.employee.name,
      employeeId: u.employee.employeeId,
      biometricCode: u.biometricCode
    }))
  };
};

// ─── SYNC ALL DEVICES ────────────────────────────────────────────────────
// Sync attendance from all active devices in parallel
exports.syncAllDevices = async (configId, dateRange, user) => {
  const scopeFilter = buildScopeFilter(user);
  
  const config = await BiometricConfig.findOne({
    _id: configId,
    ...scopeFilter,
    isDeleted: false
  });
  
  if (!config) {
    throw new AppError('Biometric config not found', 404);
  }
  
  const activeDevices = config.devices.filter(d => d.isActive);
  
  if (activeDevices.length === 0) {
    return {
      success: true,
      message: 'No active devices to sync',
      synced: 0,
      failed: 0,
      results: []
    };
  }
  
  console.log(`[BiometricService] Syncing ${activeDevices.length} devices in parallel`);
  
  // Sync all devices in parallel
  const syncPromises = activeDevices.map(async (device) => {
    try {
      const result = await exports.pullAttendanceFromDevice(
        configId,
        device.serialNumber,
        dateRange,
        user
      );
      
      return {
        device: device.serialNumber,
        success: result.success,
        recordsCreated: result.recordsCreated || 0,
        recordsMatched: result.recordsMatched || 0,
        error: null
      };
    } catch (error) {
      console.error(`[BiometricService] Sync failed for device ${device.serialNumber}:`, error);
      return {
        device: device.serialNumber,
        success: false,
        recordsCreated: 0,
        recordsMatched: 0,
        error: error.message
      };
    }
  });
  
  const results = await Promise.all(syncPromises);
  
  const synced = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalCreated = results.reduce((sum, r) => sum + r.recordsCreated, 0);
  const totalMatched = results.reduce((sum, r) => sum + r.recordsMatched, 0);
  
  return {
    success: true,
    message: `Synced ${synced}/${activeDevices.length} devices`,
    synced,
    failed,
    totalCreated,
    totalMatched,
    results
  };
};

 