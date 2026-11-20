'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isolatedCore, duringFileEvent } = require('./helpers');
const { layout } = require('../native/fixtures');
const { SnapshotStore } = require('../../native/store');

test('host recorder keeps saving after its launching client exits',
  { timeout: 30000 }, async t => {
    const core = isolatedCore(t);
    const records = path.join(core.root, 'records');
    fs.mkdirSync(records);
    const ready = path.join(core.root, 'agent-ready');
    const agent = await duringFileEvent(ready, () => core.client.request('terminal.run', {
      argv: [process.execPath, path.resolve(__dirname, '../fixtures/agent.js')],
      cwd: core.root, no_parent: true, no_notify: true, outlive_parent: true,
      env: { TEST_TOOL: 'opencode', TEST_SESSION: 'ses_disconnected',
        TEST_RECORDS: records, TEST_READY: ready },
    }));
    const document = layout([agent.address]);
    await core.client.request('doc.set', { name: 'herdr-app', version: 0, value: document });
    const directory = path.join(core.root, 'persistent');
    fs.mkdirSync(directory);
    const stopped = path.join(core.root, 'worker-stopped');
    let pid;
    core.beforeStop(async () => {
      if (!pid) return;
      await duringFileEvent(stopped, async () => {
        try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      });
    });
    await duringFileEvent(path.join(directory, 'last.json'), async () => {
      const launch = execFileSync(process.execPath, [
        path.resolve(__dirname, '../fixtures/launcher.js'),
        path.resolve(__dirname, '../fixtures/recorder-worker.js'),
        path.join(core.root, 'recorder.log'),
        '--state-dir', directory, '--opencode-state-dir', records,
        '--interval-ms', '25', '--hc', core.hc,
      ], { env: { ...core.env, TEST_STOPPED: stopped }, encoding: 'utf8', timeout: 10000 });
      pid = JSON.parse(launch).pid;
    });
    const store = new SnapshotStore(directory);
    assert.equal(store.load().programs[0].session, 'ses_disconnected');
    const saved = await core.client.request('doc.get', { name: 'herdr-app' });
    saved.value.spaces[0].tabs[0].name = 'Changed after launcher exited';
    await duringFileEvent(path.join(directory, 'last.json'), () => core.client.request('doc.set', {
      name: 'herdr-app', version: saved.version, value: saved.value,
    }), () => store.load()?.layout.spaces[0].tabs[0].name === 'Changed after launcher exited');
    assert.equal(store.load().layout.spaces[0].tabs[0].name, 'Changed after launcher exited');
    assert.equal(store.load().programs[0].session, 'ses_disconnected');
    await duringFileEvent(path.join(directory, 'last.json'), async () => {
      core.command(['server', 'stop']);
      core.command(['server', 'start']);
    }, () => store.load()?.programs[0].observed?.state === 'unresolved');
    assert.equal(store.load().programs[0].session, 'ses_disconnected');
    assert.ok(store.load().programs[0].verified_at < store.load().at);
  });
