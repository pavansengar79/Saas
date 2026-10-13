const test = require('node:test');
const assert = require('node:assert/strict');
const { BiometricSoapClient } = require('./biometricSoap.client');

const createClient = () => new BiometricSoapClient({
  serverUrl: 'http://localhost/iclock/WebAPIService.asmx',
  username: 'test-user',
  password: 'test-password'
});

test('server test reports SOAP request failures', async () => {
  const client = createClient();
  client.getTransactionsLog = async () => ({ success: false, error: 'Connection refused' });

  assert.deepEqual(await client.testConnection(), {
    success: false,
    error: 'Connection refused'
  });
});

test('server test reports a successful SOAP response', async () => {
  const client = createClient();
  client.getTransactionsLog = async () => ({ success: true, rawResult: '' });

  assert.deepEqual(await client.testConnection(), {
    success: true,
    message: 'Connection successful'
  });
});

test('server test rejects authentication failures', async () => {
  const client = createClient();
  client.getTransactionsLog = async () => ({ success: true, rawResult: 'Authentication failed' });

  assert.deepEqual(await client.testConnection(), {
    success: false,
    error: 'Authentication failed'
  });
});