// modules/biometric/biometricSoap.client.js
// Low-Level SOAP Client for eSSL eTimetracklite Web API v1.3
//
// Implements all 13 methods from official eSSL API documentation.
// SOAP 1.1 with explicit XML parameters (NOT JSON-inside-XML).
//
// Key findings from official docs:
// - Date format for GetTransactionsLog: "yyyy/MM/dd HH:mm"
// - Date format for other date fields: "yyyy-MM-dd"
// - EmployeeCode must be numeric (string type, but digits only)
// - CommandId is int type for requests, returned as string in response
// - Bulk operations accept JSON array as string in specific parameter

const axios = require('axios');
const xml2js = require('xml2js');

// ─── Date Formatting Helpers ────────────────────────────────────────────

/**
 * Format date for GetTransactionsLog: "yyyy/MM/dd HH:mm"
 * Example: "2021/05/22 09:05"
 */
function formatTransactionDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${mins}`;
}

/**
 * Format date for database operations: "yyyy-MM-dd"
 */
function formatDatabaseDate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Escape XML special characters
 */
function escapeXml(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── SOAP Envelope Builder ──────────────────────────────────────────────

/**
 * Parameters that must be sent as integers in SOAP XML (not strings)
 * eSSL API requires these as numeric types
 */
const INT_PARAMS = ['EmployeeCode', 'CommandId', 'FingerIndex', 'GroupId', 'FingerIndexNumber'];

/**
 * Parameters that must be sent as boolean in SOAP XML (lowercase true/false)
 * eSSL API requires lowercase boolean values
 */
const BOOL_PARAMS = ['isOverWrite'];

function buildSoapEnvelope(methodName, params) {
  const paramsXml = Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      // Send integers without quotes for eSSL compatibility
      if (INT_PARAMS.includes(k)) {
        const num = typeof v === 'number' ? v : parseInt(String(v), 10);
        if (!isNaN(num)) {
          return `<${k}>${num}</${k}>`;
        }
      }
      // Handle booleans - must be lowercase true/false
      if (BOOL_PARAMS.includes(k) || typeof v === 'boolean') {
        return `<${k}>${v ? 'true' : 'false'}</${k}>`;
      }
      // Everything else as strings (escaped)
      return `<${k}>${escapeXml(String(v))}</${k}>`;
    })
    .join('\n      ');

  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${methodName} xmlns="http://tempuri.org/">
      ${paramsXml}
    </${methodName}>
  </soap:Body>
</soap:Envelope>`;
}

// ─── SOAP Response Parser ───────────────────────────────────────────────

async function parseSoapResponse(xmlResponse, methodName) {
  const parser = new xml2js.Parser({
    explicitArray: false,
    ignoreAttrs: true
  });

  try {
    const result = await parser.parseStringPromise(xmlResponse);
    
    // Navigate to response element
    const envelope = result['soap:Envelope'] || result['Envelope'];
    if (!envelope) {
      throw new Error('Invalid SOAP response: missing envelope');
    }

    const body = envelope['soap:Body'] || envelope['Body'];
    if (!body) {
      throw new Error('Invalid SOAP response: missing body');
    }

    const response = body[`${methodName}Response`];
    if (!response) {
      throw new Error(`Invalid SOAP response: missing ${methodName}Response`);
    }

    // Extract result and CommandId
    const resultText = response[`${methodName}Result`] || '';
    const commandId = response['CommandId'] || response['commandId'] || null;
    const strDataList = response['strDataList'] || response['StrDataList'] || null;

    // Try to parse result as JSON if it looks like JSON
    let parsedResult = resultText;
    if (typeof resultText === 'string' && resultText.trim().startsWith('[')) {
      try {
        parsedResult = JSON.parse(resultText);
      } catch {
        // Keep as string if parse fails
      }
    }

    return {
      success: true,
      result: parsedResult,
      commandId: commandId ? parseInt(commandId, 10) : null,
      rawResult: resultText,
      strDataList: strDataList,
      raw: xmlResponse
    };
  } catch (err) {
    console.error(`[BiometricSoapClient] Parse error for ${methodName}:`, err.message);
    return {
      success: false,
      error: err.message,
      raw: xmlResponse
    };
  }
}

// ─── Client Class ────────────────────────────────────────────────────────

class BiometricSoapClient {
  /**
   * @param {Object} config
   * @param {string} config.serverUrl - eSSL server URL (e.g., "http://192.168.1.100/iclock/WebAPIService.asmx")
   * @param {string} config.apiKey - API key for authentication
   * @param {string} config.username - Auth username
   * @param {string} config.password - Auth password
   * @param {number} [config.timeout=30000] - Request timeout in ms
   */
  constructor(config) {
    if (!config.serverUrl) {
      throw new Error('serverUrl is required');
    }
    if (!config.username || !config.password) {
      throw new Error('username and password are required');
    }

    this.serverUrl = config.serverUrl.replace(/\/+$/, ''); // Remove trailing slashes
    this.apiKey = config.apiKey || '';
    this.username = config.username;
    this.password = config.password;
    this.timeout = config.timeout || 10000; // 10s timeout

    // Create axios instance
    this.httpClient = axios.create({
      timeout: this.timeout,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8'
      }
    });
  }

  /**
   * Execute a SOAP request
   * @private
   */
  async _execute(methodName, params) {
    const envelope = buildSoapEnvelope(methodName, params);
    const soapAction = `http://tempuri.org/${methodName}`;

    try {
      const response = await this.httpClient.post(this.serverUrl, envelope, {
        headers: { 'SOAPAction': soapAction }
      });

      return await parseSoapResponse(response.data, methodName);
    } catch (err) {
      // Extract meaningful error from SOAP fault or HTTP error
      let errorMsg = err.message;
      let errorDetails = err.response?.data || null;
      
      // Try to parse SOAP fault for better error message
      if (errorDetails && typeof errorDetails === 'string') {
        const faultMatch = errorDetails.match(/<faultstring>([^<]+)<\/faultstring>/i);
        if (faultMatch) {
          errorMsg = faultMatch[1];
        }
      }
      
      console.error(`[BiometricSoapClient] ${methodName} failed:`, errorMsg);
      console.error(`[BiometricSoapClient] Request params:`, JSON.stringify({
        ...params,
        UserPassword: '[REDACTED]'
      }));

      return {
        success: false,
        error: errorMsg,
        details: errorDetails,
        isServerError: err.response?.status >= 500
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC METHODS - All 13 ESSL Web API Methods
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add single employee to device
   * 
   * @param {Object} options
   * @param {string} options.serialNumber - Device serial number (e.g., "BRM9202760325")
   * @param {string|number} options.employeeCode - Numeric employee code (digits only)
   * @param {string} options.employeeName - Employee display name
   * @param {string} [options.cardNumber] - RFID card number (optional)
   * @returns {Promise<Object>} { success, result, commandId }
   */
  async addEmployee(options) {
    const { serialNumber, employeeCode, employeeName, cardNumber } = options;

    if (!serialNumber || !employeeCode || !employeeName) {
      throw new Error('serialNumber, employeeCode, and employeeName are required');
    }

    // Parse employeeCode as integer - eSSL requires int
    const empCodeInt = parseInt(String(employeeCode), 10);
    if (isNaN(empCodeInt)) {
      throw new Error('employeeCode must be a valid number');
    }

    // Build params - CommandId must be int (0 for new), CardNumber only if has value
    const params = {
      APIKey: this.apiKey || '',
      EmployeeCode: empCodeInt,        // Must be int
      EmployeeName: String(employeeName),
      SerialNumber: String(serialNumber),
      UserName: this.username,
      UserPassword: this.password,
      CommandId: 0                     // Must be int - use 0 for new command
    };

    // Only include CardNumber if it has a value (don't send empty string)
    if (cardNumber && String(cardNumber).trim()) {
      params.CardNumber = String(cardNumber);
    }

    console.log('[BiometricSoapClient] AddEmployee params:', JSON.stringify({
      ...params,
      UserPassword: '[REDACTED]'
    }));

    return this._execute('AddEmployee', params);
  }

  /**
   * Add employee by company short name
   * 
   * @param {Object} options
   * @param {string} options.serialNumber - Device serial number
   * @param {string} options.employeeCode - Numeric employee code
   * @param {string} options.employeeName - Employee display name
   * @param {string} [options.cardNumber] - RFID card number
   * @param {string} [options.groupId='1'] - Group ID (default: 1)
   * @param {string} options.companyCode - Company short name
   * @returns {Promise<Object>}
   */
  async addEmployeeByCompanyShortName(options) {
    const { serialNumber, employeeCode, employeeName, cardNumber = '', groupId = '1', companyCode } = options;

    if (!serialNumber || !employeeCode || !employeeName || !companyCode) {
      throw new Error('serialNumber, employeeCode, employeeName, and companyCode are required');
    }

    return this._execute('AddEmployeeByCompanyShortName', {
      APIKey: this.apiKey,
      EmployeeCode: String(employeeCode),
      EmployeeName: String(employeeName),
      CardNumber: String(cardNumber),
      GroupId: String(groupId),
      CompanyCode: String(companyCode),
      SerialNumber: String(serialNumber),
      UserName: this.username,
      UserPassword: this.password,
      CommandId: ''
    });
  }

  /**
   * Add multiple employees to a master device
   * 
   * @param {string} serialNumber - Master device serial number
   * @param {Array<{EmployeeCode: string}>} employees - Array of employee codes
   * @returns {Promise<Object>} { success, result, commandIds }
   */
  async addMultipleEmployees(serialNumber, employees) {
    if (!serialNumber || !Array.isArray(employees) || employees.length === 0) {
      throw new Error('serialNumber and non-empty employees array are required');
    }

    // Format: [{"EmployeeCode":"1600"},{"EmployeeCode":"1700"}]
    const employeesJson = JSON.stringify(employees);

    return this._execute('AddMultipleEmployees', {
      APIKey: this.apiKey,
      EmployeesDataInJsonFormat: employeesJson,
      SerialNumber: String(serialNumber),
      UserName: this.username,
      UserPassword: this.password,
      CommandIds: '' // Blank for new commands
    });
  }

  /**
   * Block or unblock a user on device
   * 
   * @param {Object} options
   * @param {string} options.serialNumber - Device serial number
   * @param {string} options.employeeCode - Employee code to block/unblock
   * @param {string} options.employeeName - Employee name
   * @param {boolean} options.isBlock - True to block, False to unblock
   * @returns {Promise<Object>}
   */
  async blockUnblockUser(options) {
    const { serialNumber, employeeCode, employeeName, isBlock } = options;

    if (!serialNumber || !employeeCode || !employeeName) {
      throw new Error('serialNumber, employeeCode, and employeeName are required');
    }

    return this._execute('BlockUnblockUser', {
      APIKey: this.apiKey,
      EmployeeCode: String(employeeCode),
      EmployeeName: String(employeeName),
      SerialNumber: String(serialNumber),
      IsBlock: isBlock ? 'True' : 'False',
      UserName: this.username,
      UserPassword: this.password,
      CommandId: ''
    });
  }

  /**
   * Delete multiple employees from a master device
   * 
   * @param {string} serialNumber - Master device serial number
   * @param {Array<{EmployeeCode: string}>} employeeCodes - Array of employee codes to delete
   * @returns {Promise<Object>}
   */
  async deleteMultipleEmployees(serialNumber, employeeCodes) {
    if (!serialNumber || !Array.isArray(employeeCodes) || employeeCodes.length === 0) {
      throw new Error('serialNumber and non-empty employeeCodes array are required');
    }

    // Format: [{"EmployeeCode":"1600"},{"EmployeeCode":"1700"}]
    const employeesJson = JSON.stringify(employeeCodes);

    return this._execute('DeleteMultipleEmployees', {
      APIKey: this.apiKey,
      EmployeesDataInJsonFormat: employeesJson,
      SerialNumber: String(serialNumber),
      UserName: this.username,
      UserPassword: this.password,
      CommandIds: ''
    });
  }

  /**
   * Delete single employee from device
   * 
   * @param {string} serialNumber - Device serial number
   * @param {string} employeeCode - Employee code to delete
   * @returns {Promise<Object>}
   */
  async deleteUser(serialNumber, employeeCode) {
    if (!serialNumber || !employeeCode) {
      throw new Error('serialNumber and employeeCode are required');
    }

    return this._execute('DeleteUser', {
      APIKey: this.apiKey,
      EmployeeCode: String(employeeCode),
      SerialNumber: String(serialNumber),
      UserName: this.username,
      UserPassword: this.password,
      CommandId: ''
    });
  }

  /**
   * Enroll user fingerprint on device
   * 
   * @param {Object} options
   * @param {string} options.serialNumber - Device serial number
   * @param {string|number} options.employeeCode - Employee code (numeric)
   * @param {number} options.fingerIndex - Finger index (0-9)
   * @param {boolean} [options.isOverWrite=true] - Overwrite existing template
   * @returns {Promise<Object>}
   */
  async enrollUserFP(options) {
    const { serialNumber, employeeCode, fingerIndex, isOverWrite = true } = options;

    if (!serialNumber || !employeeCode || fingerIndex === undefined) {
      throw new Error('serialNumber, employeeCode, and fingerIndex are required');
    }

    // Parse employeeCode as integer
    const empCodeInt = parseInt(String(employeeCode), 10);
    if (isNaN(empCodeInt)) {
      throw new Error('employeeCode must be a valid number');
    }

    return this._execute('EnrollUserFP', {
      APIKey: this.apiKey || '',
      EmployeeCode: empCodeInt,                          // Must be int
      FingerIndexNumber: parseInt(fingerIndex, 10),     // Must be int
      isOverWrite: isOverWrite ? true : false,          // Boolean (lowercase)
      SerialNumber: String(serialNumber),
      UserName: this.username,
      UserPassword: this.password,
      CommandId: 0                                      // Must be int
    });
  }

  /**
   * Enroll user face on device
   * 
   * @param {Object} options
   * @param {string} options.serialNumber - Device serial number
   * @param {string} options.employeeCode - Employee code
   * @param {boolean} [options.isOverWrite=true] - Overwrite existing template
   * @returns {Promise<Object>}
   */
  async enrollUserFace(options) {
    const { serialNumber, employeeCode, isOverWrite = true } = options;

    if (!serialNumber || !employeeCode) {
      throw new Error('serialNumber and employeeCode are required');
    }

    // Parse employeeCode as integer
    const empCodeInt = parseInt(String(employeeCode), 10);
    if (isNaN(empCodeInt)) {
      throw new Error('employeeCode must be a valid number');
    }

    return this._execute('EnrollUserFace', {
      APIKey: this.apiKey || '',
      EmployeeCode: empCodeInt,                          // Must be int
      isOverWrite: isOverWrite ? true : false,          // Boolean (lowercase)
      SerialNumber: String(serialNumber),
      UserName: this.username,
      UserPassword: this.password,
      CommandId: 0                                      // Must be int
    });
  }

  /**
   * Get command status by CommandId
   * 
   * @param {string|number} commandId - Command ID returned from previous operation
   * @returns {Promise<Object>} { success, result, commandId }
   */
  async getCommandStatus(commandId) {
    if (!commandId) {
      throw new Error('commandId is required');
    }

    return this._execute('GetCommandStatus', {
      CommandId: String(commandId),
      UserName: this.username,
      UserPassword: this.password
    });
  }

  /**
   * Get transactions log (attendance punches) from device
   * 
   * @param {Object} options
   * @param {string} options.serialNumber - Device serial number
   * @param {Date|string} options.fromDateTime - Start datetime
   * @param {Date|string} options.toDateTime - End datetime
   * @returns {Promise<Object>} { success, result, strDataList }
   */
  async getTransactionsLog(options) {
    const { serialNumber, fromDateTime, toDateTime } = options;

    if (!serialNumber || !fromDateTime || !toDateTime) {
      throw new Error('serialNumber, fromDateTime, and toDateTime are required');
    }

    // Format: "yyyy/MM/dd HH:mm" per docs
    const fromDateStr = typeof fromDateTime === 'string' 
      ? fromDateTime 
      : formatTransactionDate(fromDateTime);
    const toDateStr = typeof toDateTime === 'string'
      ? toDateTime
      : formatTransactionDate(toDateTime);

    return this._execute('GetTransactionsLog', {
      FromDateTime: fromDateStr,
      ToDateTime: toDateStr,
      SerialNumber: String(serialNumber),
      UserName: this.username,
      UserPassword: this.password,
      strDataList: '' // Blank for request
    });
  }

  /**
   * Add multiple employees to the application database (not device)
   * 
   * @param {Array<Object>} employees - Employee data array
   * @returns {Promise<Object>}
   */
  async addMultipleEmployeesToDB(employees) {
    if (!Array.isArray(employees) || employees.length === 0) {
      throw new Error('non-empty employees array is required');
    }

    // Each employee should have: EmployeeCode, EmployeeName, CompanySName, 
    // DepartmentSName, SubDepartment, Location, Designation, Division, 
    // Grade, EmployementType, Gender, DateOfJoin, etc.
    const employeesJson = JSON.stringify(employees);

    return this._execute('AddMultipleEmployeesToDB', {
      EmployeesDataInJsonFormat: employeesJson,
      UserName: this.username,
      UserPassword: this.password,
      ErrorStatus: ''
    });
  }

  /**
   * Add multiple leave entries to the application
   * 
   * @param {Array<Object>} leaveEntries - Leave entry array
   * @returns {Promise<Object>}
   */
  async addMultipleLeaveEntries(leaveEntries) {
    if (!Array.isArray(leaveEntries) || leaveEntries.length === 0) {
      throw new Error('non-empty leaveEntries array is required');
    }

    // Each entry: EmployeeCode, LeaveFromDate, LeaveToDate, LeaveDuration,
    // LeaveTypeSName, IsApproved, Remarks
    const leaveJson = JSON.stringify(leaveEntries);

    return this._execute('AddMultipleLeaveEntries', {
      LeaveEntryDataInJsonFormat: leaveJson,
      UserName: this.username,
      UserPassword: this.password,
      ErrorStatus: ''
    });
  }

  /**
   * Add or delete multiple holidays in the application
   * 
   * @param {string} operationType - "add" or "delete"
   * @param {Array<Object>} holidays - Holiday array
   * @returns {Promise<Object>}
   */
  async addOrDeleteMultipleHolidays(operationType, holidays) {
    if (!operationType || !['add', 'delete'].includes(operationType)) {
      throw new Error('operationType must be "add" or "delete"');
    }
    if (!Array.isArray(holidays) || holidays.length === 0) {
      throw new Error('non-empty holidays array is required');
    }

    // Each holiday: HolidayName, HolidayDate (yyyy-MM-dd), CompanySName, Remarks
    const holidaysJson = JSON.stringify(holidays);

    return this._execute('AddOrDeleteMultipleHolidays', {
      HolidaysDataInJsonFormat: holidaysJson,
      UserName: this.username,
      UserPassword: this.password,
      OperationType: operationType,
      ErrorStatus: ''
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Convenience Methods
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Block a user (convenience method)
   */
  async blockUser(serialNumber, employeeCode, employeeName) {
    return this.blockUnblockUser({ serialNumber, employeeCode, employeeName, isBlock: true });
  }

  /**
   * Unblock a user (convenience method)
   */
  async unblockUser(serialNumber, employeeCode, employeeName) {
    return this.blockUnblockUser({ serialNumber, employeeCode, employeeName, isBlock: false });
  }

  /**
   * Delete employee (alias for deleteUser)
   */
  async deleteEmployee(serialNumber, employeeCode) {
    return this.deleteUser(serialNumber, employeeCode);
  }

  /**
   * Enroll fingerprint (alias for enrollUserFP)
   */
  async enrollFingerprint(serialNumber, employeeCode, fingerIndex = 0) {
    return this.enrollUserFP({ serialNumber, employeeCode, fingerIndex, isOverWrite: true });
  }

  /**
   * Enroll face (alias for enrollUserFace)
   */
  async enrollFace(serialNumber, employeeCode) {
    return this.enrollUserFace({ serialNumber, employeeCode, isOverWrite: true });
  }

  /**
   * Pull transactions (alias for getTransactionsLog)
   */
  async pullTransactions(serialNumber, fromDateTime, toDateTime) {
    return this.getTransactionsLog({ serialNumber, fromDateTime, toDateTime });
  }

  /**
   * Test connection by making a simple request
   */
  async testConnection() {
    try {
      // Make a minimal getTransactionsLog request to test auth
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      
      // If we get any response without auth error, connection works
      const result = await this.getTransactionsLog({
        serialNumber: 'TEST_CONNECTION',
        fromDateTime: formatTransactionDate(oneHourAgo),
        toDateTime: formatTransactionDate(now)
      });

      if (!result.success) {
        return { success: false, error: result.error || 'Connection failed' };
      }

      // Check if authentication failed
      if (result.rawResult && result.rawResult.toLowerCase().includes('authentication')) {
        return { success: false, error: 'Authentication failed' };
      }

      return { success: true, message: 'Connection successful' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  BiometricSoapClient,
  // Export helpers for testing
  formatTransactionDate,
  formatDatabaseDate,
  escapeXml,
  buildSoapEnvelope,
  parseSoapResponse
};
