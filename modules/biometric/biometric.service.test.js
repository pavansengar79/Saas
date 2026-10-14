const test = require('node:test');
const assert = require('node:assert/strict');
const BiometricConfig = require('./models/biometricConfig.model');
const BiometricSyncLog = require('./models/biometricSyncLog.model');
const BiometricCommand = require('./models/biometricCommand.model');
const Attendance = require('../attendance/models/attendance.model');
const { ESSLAdapter } = require('./adapters/essl.adapter');
const biometricService = require('./biometric.service');

const scopedUser = { orgId: 'org-id', companyId: 'company-id', unitId: 'unit-id', level: 'unit' };

test('updating config with empty secret fields preserves saved credentials', async (context) => {
  const config = {
    apiKey: '11',
    password: 'saved-password',
    serverUrl: 'http://localhost/iclock/WebAPIService.asmx',
    save: async () => {},
    toObject() { return { ...this }; }
  };
  context.mock.method(BiometricConfig, 'findOne', async () => config);

  await biometricService.updateConfig('config-id', {
    apiKey: '',
    password: '',
    serverUrl: 'http://localhost/iclock/WebAPIService.asmx'
  }, { orgId: 'org-id', companyId: 'company-id', _id: 'user-id' });

  assert.equal(config.apiKey, '11');
  assert.equal(config.password, 'saved-password');
});

test('sync log responses redact device records without a verified owner', async (context) => {
  const storedLog = {
    unit_id: 'unit-id',
    recordsFetched: 56,
    recordsMatched: 0,
    recordsUnmatched: 13,
    lastRecordId: 'device-record-id',
    unmatchedRecords: [{ employeeCode: '30', punchTime: new Date() }],
    toObject() { return { ...this }; }
  };
  context.mock.method(BiometricSyncLog, 'findOne', async () => storedLog);
  context.mock.method(BiometricSyncLog, 'find', () => ({
    sort() { return this; },
    limit: async () => [storedLog]
  }));

  const details = await biometricService.getSyncLogDetails('log-id', scopedUser);
  const logs = await biometricService.getSyncLogs('unit-id', {}, scopedUser);
  for (const visibleLog of [details, logs[0]]) {
    assert.equal(visibleLog.recordsFetched, 0);
    assert.equal(visibleLog.recordsUnmatched, 0);
    assert.equal(visibleLog.lastRecordId, null);
    assert.deepEqual(visibleLog.unmatchedRecords, []);
  }

  const unmatchedPage = await biometricService.getSyncLogRecords('log-id', 'unmatched', 1, 20, scopedUser);
  assert.deepEqual(unmatchedPage, { records: [], total: 0, page: 1, totalPages: 0 });
});

test('matched sync log records are queried within the logged unit', async (context) => {
  context.mock.method(BiometricSyncLog, 'findOne', async () => ({ unit_id: 'unit-id' }));
  let attendanceFilter;
  let countFilter;
  context.mock.method(Attendance, 'find', (filter) => {
    attendanceFilter = filter;
    return {
      populate() { return this; },
      sort() { return this; },
      skip() { return this; },
      limit: async () => []
    };
  });
  context.mock.method(Attendance, 'countDocuments', async (filter) => {
    countFilter = filter;
    return 0;
  });

  await biometricService.getSyncLogRecords('log-id', 'matched', 1, 20, scopedUser);
  assert.equal(attendanceFilter.unit_id, 'unit-id');
  assert.equal(countFilter.unit_id, 'unit-id');
  assert.equal(attendanceFilter.company_id, 'company-id');
});

test('command status poll respects tenant scope and resolves adapter success', async (context) => {
  let commandFilter;
  let configFilter;
  const command = {
    commandId: '53', org_id: 'org-id', company_id: 'company-id', unit_id: 'unit-id', deviceSerialNumber: 'serial', attempts: 0,
    async incrementAttempt() { this.attempts++; },
    async markSuccess(response) { this.status = 'SUCCESS'; this.responseData = response; }
  };
  context.mock.method(BiometricCommand, 'findOne', async (filter) => {
    commandFilter = filter;
    return command;
  });
  context.mock.method(BiometricConfig, 'findOne', async (filter) => {
    configFilter = filter;
    return { _id: 'config-id', vendor: 'ESSL' };
  });
  context.mock.method(BiometricConfig, 'findById', () => ({
    select: async () => ({ serverUrl: 'http://localhost', username: 'test', password: 'test', vendor: 'ESSL' })
  }));
  context.mock.method(ESSLAdapter.prototype, 'getCommandStatus', async () => ({ success: true, status: 'Success' }));

  const result = await biometricService.pollCommandStatus('53', scopedUser);
  assert.equal(commandFilter.org_id, 'org-id');
  assert.equal(commandFilter.company_id, 'company-id');
  assert.equal(commandFilter.unit_id, 'unit-id');
  assert.equal(configFilter.org_id, 'org-id');
  assert.equal(configFilter.company_id, 'company-id');
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.attempts, 1);
});

test('command status poll resolves eSSL Failure as failed', async (context) => {
  const command = {
    commandId: '54', org_id: 'org-id', company_id: 'company-id', unit_id: 'unit-id',
    deviceSerialNumber: 'serial', attempts: 0,
    async incrementAttempt() { this.attempts++; },
    async markFailed(error) { this.status = 'FAILED'; this.error = error; }
  };
  context.mock.method(BiometricCommand, 'findOne', async () => command);
  context.mock.method(BiometricConfig, 'findOne', async () => ({ _id: 'config-id', vendor: 'ESSL' }));
  context.mock.method(BiometricConfig, 'findById', () => ({
    select: async () => ({ serverUrl: 'http://localhost', username: 'test', password: 'test', vendor: 'ESSL' })
  }));
  context.mock.method(ESSLAdapter.prototype, 'getCommandStatus', async () => ({ success: true, status: 'Failure' }));

  const result = await biometricService.pollCommandStatus('54', scopedUser);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error, 'Failure');
});