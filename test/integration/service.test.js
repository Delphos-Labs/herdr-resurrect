'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { CoreClient } = require('../../native/core');
const { executable } = require('../../native/config');
const { processStart } = require('../../native/capture');
const { duringFileEvent } = require('./helpers');

test('a temporary recorder service does not own or stop the core it starts',
  { timeout: 30000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-service-'));
    const name = `herdr-resurrect-test-${randomUUID()}`;
    const session = `hr-${randomUUID().slice(0, 12)}`;
    const runtime = `/run/user/${process.getuid()}`;
    const config = {
      version: 1, hc: executable('hc'), session, intervalMs: 1000,
      stateDir: path.join(root, 'snapshots'), opencodeStateDir: path.join(root, 'agents'),
      claudeConfigDir: path.join(root, 'claude'),
    };
    fs.mkdirSync(config.stateDir);
    const configFile = path.join(root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(HC_|HERDR_|TMUX)/.test(key)));
    Object.assign(env, {
      HC_SESSION: session, XDG_RUNTIME_DIR: runtime,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_STATE_HOME: path.join(root, 'state'),
    });
    let started = false;
    let core;
    let pid;
    let start;
    const systemctl = args => execFileSync('systemctl', ['--user', ...args], {
      env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      try {
        if (started) systemctl(['stop', `${name}.service`]);
        core?.close();
        if (pid) {
          let alive = false;
          try { alive = processStart(pid) === start; } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
          }
          if (alive) execFileSync(config.hc, ['server', 'stop'], {
            env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
          });
        } else if (fs.existsSync(path.join(runtime, 'herdr-core', `${session}.sock`))) {
          execFileSync(config.hc, ['server', 'stop'], {
            env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
          });
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    const properties = [
      `HC_SESSION=${session}`, `XDG_RUNTIME_DIR=${runtime}`,
      `XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}`, `XDG_STATE_HOME=${env.XDG_STATE_HOME}`,
      `XDG_DATA_HOME=${env.XDG_DATA_HOME}`, `PATH=${process.env.PATH}`,
    ];
    const healthFile = path.join(config.stateDir, 'health.json');
    await duringFileEvent(healthFile, async () => {
      execFileSync('systemd-run', [
        '--user', '--quiet', '--collect', '--service-type=exec', '--unit', name,
        '-p', 'UMask=0077', '-p', 'KillMode=control-group',
        ...properties.flatMap(value => ['--setenv', value]),
        process.execPath, path.resolve(__dirname, '../../bin/native-recorder.js'), '--config', configFile,
      ], { env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      started = true;
    }, () => Boolean(JSON.parse(fs.readFileSync(healthFile)).savedAt), 15000);
    const health = JSON.parse(fs.readFileSync(healthFile));
    core = new CoreClient({ binary: config.hc, env });
    const status = await core.request('server.status');
    const snapshot = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'last.json')));
    assert.equal(status.core.id, snapshot.core.id);
    pid = status.pid;
    start = processStart(pid);
    const recorderGroup = fs.readFileSync(`/proc/${health.pid}/cgroup`, 'utf8');
    const coreGroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    assert.ok(recorderGroup.includes(name));
    assert.ok(!coreGroup.includes(name), 'Stopping the recorder must not kill the core or its holders.');
    systemctl(['stop', `${name}.service`]);
    started = false;
    assert.equal(processStart(pid), start, 'The same core process must survive recorder service stop.');
    assert.equal((await core.request('server.status')).pid, pid);
  });
