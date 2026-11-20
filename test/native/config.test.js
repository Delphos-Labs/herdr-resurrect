'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { coreEnv } = require('../../native/config');

test('a control command cannot inherit a different terminal or socket binding', () => {
  const env = {
    HC_SESSION: 'other', HC_TERMINAL_ID: 't9', HC_TERMINAL_SOCKET: '/other.sock',
    HC_SOCKET: '/caller-override.sock', HC_SCOPE: 'other', PATH: '/bin',
  };
  const result = coreEnv({ session: 'managed' }, env);
  assert.deepEqual(result, { HC_SESSION: 'managed', PATH: '/bin' });
  assert.equal(coreEnv({ session: 'managed', socket: '/configured.sock' }, env).HC_SOCKET, '/configured.sock');
  assert.equal(env.HC_SESSION, 'other');
});
