'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isolatedCore, duringFileEvent } = require('./helpers');
const { observeOutput } = require('./observe');
const { SnapshotStore } = require('../../native/store');
const { hostOptions } = require('../../native/config');
const { captureLocal } = require('../../native/capture');
const { restore } = require('../../native/restore');
const { layout } = require('../native/fixtures');

test('a kept terminal waits for approval and resumes in place without killing an interactive shell',
  { timeout: 30000 }, async t => {
    const core = isolatedCore(t);
    const bin = path.join(core.root, 'bin');
    const stateDir = path.join(core.root, 'snapshots');
    fs.mkdirSync(bin);
    const counter = path.join(core.root, 'starts');
    const fake = path.join(bin, 'btop');
    fs.writeFileSync(fake, `#!${process.execPath}\n`
      + 'const fs = require("node:fs"); process.title = "btop";\n'
      + `const file = ${JSON.stringify(counter)};\n`
      + 'const n = fs.existsSync(file) ? Number(fs.readFileSync(file)) + 1 : 1;\n'
      + 'fs.writeFileSync(file, String(n)); console.log("GENERATION_" + n); process.stdin.resume();\n',
    { mode: 0o700 });
    const config = {
      version: 1, stateDir, hc: core.hc.startsWith('/') ? core.hc : require('../../native/config').executable(core.hc),
      intervalMs: 1000, session: 'proof', opencodeStateDir: path.join(core.root, 'agents'),
      claudeConfigDir: path.join(core.root, 'claude'),
    };
    const configFile = path.join(core.root, 'recorder.json');
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    const shell = [process.execPath, path.resolve(__dirname, '../../bin/native-shell.js'),
      '--config', configFile, '--', '/bin/sh'];
    const coreConfigDir = path.join(core.env.XDG_CONFIG_HOME, 'herdr-core');
    fs.mkdirSync(coreConfigDir, { recursive: true });
    fs.writeFileSync(path.join(coreConfigDir, 'config.toml'), `shell = ${JSON.stringify(shell)}\n`);
    const env = { PATH: bin + path.delimiter + core.env.PATH };
    const terminal = await core.client.request('terminal.run', {
      argv: [fake], cwd: core.root, env, keep: true, no_parent: true, no_notify: true, outlive_parent: true,
    });
    await observeOutput(core.hc, core.env, terminal.address, text => text.includes('GENERATION_1'));
    await core.client.request('doc.set', { name: 'herdr-app', version: 0, value: layout([terminal.address]) });
    const options = hostOptions(config);
    const store = new SnapshotStore(stateDir);
    const saved = await captureLocal(core.client, options);
    assert.equal(saved.programs[0].tool, 'btop');
    store.save(saved);
    fs.mkdirSync(path.join(stateDir, 'pending'), { recursive: true });
    const pending = path.join(stateDir, 'pending', `${terminal.address}.json`);
    await duringFileEvent(pending, async () => process.kill(terminal.pid, 'SIGKILL'));
    assert.equal(fs.readFileSync(counter, 'utf8'), '1', 'Loss must not automatically restart the saved tool.');
    const waiting = await core.client.request('terminal.get', { terminal: terminal.address });
    assert.notEqual(waiting.pid, terminal.pid);
    const report = await restore(core.client, saved, { stateDir, host: options.host });
    assert.equal(report.resumedInPlace, 1);
    await observeOutput(core.hc, core.env, terminal.address, text => text.includes('GENERATION_2'));
    const resumed = await core.client.request('terminal.get', { terminal: terminal.address });
    assert.equal(resumed.pid, waiting.pid);
    assert.equal(resumed.address, terminal.address);
    const again = await restore(core.client, saved, { stateDir, host: options.host });
    assert.equal(again.started, 0);
    assert.equal(fs.readFileSync(counter, 'utf8'), '2');
  });
