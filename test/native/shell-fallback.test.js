'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const launcher = path.resolve(__dirname, '../../bin/native-shell.sh');
const gateway = path.resolve(__dirname, '../../bin/native-shell.js');

test('the launcher opens the wrapped shell when its Node executable is gone', () => {
  const result = spawnSync('/bin/sh', [launcher, '/nonexistent/node', gateway, '--config', '/x',
    '--', '/bin/sh', '-c', 'echo shell-ran "$0"', 'arg0'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'shell-ran arg0\n');
  assert.match(result.stderr, /missing; opening the shell without recovery/);
});

test('the launcher runs the gateway with the given Node executable', () => {
  const result = spawnSync('/bin/sh', [launcher, process.execPath, '-e', 'console.log("gateway-ran")'],
    { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'gateway-ran\n');
});

test('the launcher reports a missing shell instead of exiting silently', () => {
  const result = spawnSync('/bin/sh', [launcher, '/nonexistent/node', gateway], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no shell follows --/);
});

test('a gateway failure still opens the wrapped shell', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hr-shell-')), 'absent.json');
  const result = spawnSync(process.execPath, [gateway, '--config', missing,
    '--', '/bin/sh', '-c', 'echo shell-ran'], { encoding: 'utf8', env: { ...process.env, HC_SESSION: 'default' } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /shell-ran/);
  assert.match(result.stderr, /Herdr recovery shell failed/);
  assert.match(result.stderr, /Opening the shell without recovery/);
});
