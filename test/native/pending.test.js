'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { registerPending, readPending, requestResume } = require('../../native/pending');
const { processStart } = require('../../native/capture');

test('pending approval binds the host, core, terminal and live process lifetime', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-pending-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const record = {
    version: 1, terminal: 't1', host: 'host', coreId: 'core', pid: process.pid,
    start: processStart(process.pid), nonce: randomUUID(),
  };
  registerPending(directory, record);
  assert.deepEqual(readPending(directory, { address: 't1', pid: process.pid }, { host: 'host', coreId: 'core' }), record);
  assert.throws(() => readPending(directory, { address: 't1', pid: process.pid }, {
    host: 'other', coreId: 'core',
  }), /does not match/);
  registerPending(directory, { ...record, start: 'stale' });
  assert.throws(() => readPending(directory, { address: 't1', pid: process.pid }, {
    host: 'host', coreId: 'core',
  }), /identity changed/);
});

test('a complete one-use approval cannot overwrite an accepted request', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-pending-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const record = {
    version: 1, terminal: 't1', host: 'host', coreId: 'core', pid: process.pid,
    start: processStart(process.pid), nonce: randomUUID(),
  };
  const target = registerPending(directory, record);
  requestResume(directory, record, { state: 'tool', tool: 'btop' });
  assert.throws(() => requestResume(directory, record, { state: 'tool', tool: 'gh-dash' }), { code: 'EEXIST' });
  const request = JSON.parse(fs.readFileSync(path.join(target.requestDir, target.requestName)));
  assert.equal(request.program.tool, 'btop');
  assert.equal(request.nonce, record.nonce);
  assert.equal(fs.readdirSync(target.requestDir).filter(name => name.endsWith('.tmp')).length, 0);
});
