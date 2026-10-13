const test = require('node:test');
const assert = require('node:assert/strict');
const BiometricConfig = require('./models/biometricConfig.model');
const biometricService = require('./biometric.service');

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