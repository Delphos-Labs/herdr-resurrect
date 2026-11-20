'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isolatedCore, duringFileEvent } = require('../integration/helpers');
const { observeOutput } = require('../integration/observe');
const { SnapshotStore, snapshotDigest } = require('../../native/store');
const { executable, hostOptions } = require('../../native/config');
const { captureLocal } = require('../../native/capture');
const { restore } = require('../../native/restore');
const { verifySession } = require('../../native/sessions');
const { layout } = require('../native/fixtures');

test('an existing real OpenCode conversation resumes in the same kept terminal after approval',
  { timeout: 60000 }, async t => {
    const file = process.env.HERDR_BASELINE_RECEIPT;
    const base = path.resolve(__dirname, '../../.local/acceptance') + path.sep;
    assert.ok(file && path.resolve(file).startsWith(base),
      'Set HERDR_BASELINE_RECEIPT to a passed acceptance receipt in this worktree.');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(receipt.status, 'passed');
    const baseline = receipt.sessions.find(item => item.tool === 'opencode');
    assert.ok(baseline && /^ses_[A-Za-z0-9_-]+$/.test(baseline.session));
    const old = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'snapshots/last.json')));
    const original = old.programs.find(item => item.session === baseline.session);
    await verifySession(original);
    const core = isolatedCore(t);
    const stateDir = path.join(core.root, 'snapshots');
    const agents = path.join(core.root, 'agents');
    fs.mkdirSync(agents);
    const config = {
      version: 1, stateDir, hc: executable('hc'), session: 'proof', intervalMs: 1000,
      opencodeStateDir: agents, claudeConfigDir: path.join(core.root, 'claude'),
    };
    const configFile = path.join(core.root, 'recorder.json');
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    const coreConfig = path.join(core.env.XDG_CONFIG_HOME, 'herdr-core');
    fs.mkdirSync(coreConfig, { recursive: true });
    fs.writeFileSync(path.join(coreConfig, 'config.toml'), 'shell = ' + JSON.stringify([
      process.execPath, path.resolve(__dirname, '../../bin/native-shell.js'),
      '--config', configFile, '--', '/bin/sh',
    ]) + '\n');
    const env = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'),
      XDG_STATE_HOME: process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
      HERDR_RESURRECT_AGENT_DIR: agents,
      OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ plugins: [path.resolve(__dirname, '../../integrations/opencode')] }),
    };
    const terminal = await core.client.request('terminal.run', {
      argv: ['opencode', '-s', baseline.session], cwd: original.cwd, env,
      keep: true, no_parent: true, no_notify: true, outlive_parent: true,
    });
    await observeOutput(core.hc, core.env, terminal.address, text => text.includes(baseline.marker), 30000);
    const record = path.join(agents, `opencode-${terminal.pid}.json`);
    await duringFileEvent(record, async () => {}, () =>
      JSON.parse(fs.readFileSync(record)).session_id === baseline.session, 15000);
    await core.client.request('doc.set', { name: 'herdr-app', version: 0, value: layout([terminal.address]) });
    const options = hostOptions(config);
    const saved = await captureLocal(core.client, options);
    assert.equal(saved.programs[0].session, baseline.session);
    const store = new SnapshotStore(stateDir);
    store.save({ ...saved, boot: 'before-test-boot' });
    const selected = store.load();
    fs.mkdirSync(path.join(stateDir, 'pending'), { recursive: true });
    const pendingFile = path.join(stateDir, 'pending', `${terminal.address}.json`);
    await duringFileEvent(pendingFile, async () => process.kill(terminal.pid, 'SIGKILL'));
    const pending = JSON.parse(fs.readFileSync(pendingFile));
    const report = await restore(core.client, selected, { stateDir, host: options.host });
    assert.equal(report.resumedInPlace, 1);
    const nextRecord = path.join(agents, `opencode-${pending.pid}.json`);
    await duringFileEvent(nextRecord, async () => {}, () =>
      JSON.parse(fs.readFileSync(nextRecord)).session_id === baseline.session, 15000);
    await observeOutput(core.hc, core.env, terminal.address, text => text.includes(baseline.marker), 30000);
    const actual = await core.client.request('terminal.get', { terminal: terminal.address });
    assert.equal(actual.pid, pending.pid);
    assert.equal(actual.address, terminal.address);
    assert.notEqual(actual.pid, terminal.pid);
    const fresh = await captureLocal(core.client, options);
    assert.equal(fresh.programs[0].session, baseline.session);
    assert.equal(fresh.programs[0].observed, undefined);
    assert.equal(store.save(fresh).reason, 'recovery-pending');
    assert.equal(store.save(fresh, { reconciledAgainst: snapshotDigest(selected) }).saved, true);
    assert.equal((await restore(core.client, selected, { stateDir, host: options.host })).started, 0);
  });
