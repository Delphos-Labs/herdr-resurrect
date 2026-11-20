'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HostControl } = require('../../native/control');
const { atomicJson } = require('../../native/store');

test('status reads saved state without connecting to or starting a core', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-control-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const host = new HostControl({
    stateDir: directory, hc: '/unused', intervalMs: 60000,
    opencodeStateDir: '/unused/agents', claudeConfigDir: '/unused/claude', session: 'default',
  }, { connect: () => { assert.fail('Status must not connect to core.'); } });
  const status = host.status();
  assert.equal(status.snapshot, null);
  assert.equal(status.recorderActive, false);
  atomicJson(directory, 'health.json', { pid: process.pid, start: 'stale', boot: status.boot });
  assert.equal(host.status().recorderActive, false);
  assert.deepEqual(host.snapshots(), []);
});

test('restore requires an unexpired one-use host-bound preview', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-control-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const host = new HostControl({
    stateDir: directory, hc: '/unused', intervalMs: 60000,
    opencodeStateDir: '/unused/agents', claudeConfigDir: '/unused/claude', session: 'default',
  }, { connect: () => { assert.fail('Invalid preview must not connect to core.'); } });
  await assert.rejects(host.restore('../arbitrary'), /preview ticket/);
  const ticket = '12345678-1234-1234-1234-123456789abc';
  fs.mkdirSync(path.join(directory, 'previews'));
  atomicJson(path.join(directory, 'previews'), `${ticket}.json`, {
    version: 1, host: host.options.host, at: Date.now() - 600000,
  });
  await assert.rejects(host.restore(ticket), /expired/);
  await assert.rejects(host.restore(ticket), { code: 'ENOENT' });
});
