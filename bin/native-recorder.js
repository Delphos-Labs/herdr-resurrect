#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseArgs } = require('node:util');
const { CoreClient } = require('../native/core');
const { SnapshotStore, readJson, atomicJson } = require('../native/store');
const { readConfig, hostOptions, coreEnv } = require('../native/config');
const { captureLocal, processStart } = require('../native/capture');

async function main() {
  const { values } = parseArgs({
    options: {
      'state-dir': { type: 'string' },
      'opencode-state-dir': { type: 'string' },
      'claude-config-dir': { type: 'string' },
      hc: { type: 'string', default: 'hc' },
      'interval-ms': { type: 'string', default: '60000' },
      once: { type: 'boolean', default: false },
      config: { type: 'string' },
    },
  });
  const config = values.config ? readConfig(values.config) : {
    stateDir: values['state-dir'], hc: values.hc, intervalMs: Number(values['interval-ms']),
    opencodeStateDir: values['opencode-state-dir']
      || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'herdr-resurrect', 'agents'),
    claudeConfigDir: values['claude-config-dir'] || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  };
  if (!config.stateDir) throw new Error('--state-dir must name a persistent user data directory.');
  const intervalMs = config.intervalMs;
  if (!Number.isInteger(intervalMs) || intervalMs < 10) throw new Error('Invalid capture interval.');
  if (process.platform !== 'linux') throw new Error('Checkpoint-1 recording currently requires Linux.');
  const store = new SnapshotStore(config.stateDir);
  const options = hostOptions(config);
  let health = readJson(path.join(config.stateDir, 'health.json')) || {};
  const environment = values.config ? coreEnv(config) : process.env;
  let stopped = false;
  let timer;
  let wake;
  let core;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    wake?.();
    core?.close();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    do {
      try {
        core = new CoreClient({ binary: config.hc, env: environment });
        const snapshot = await captureLocal(core, options);
        const result = store.save(snapshot);
        health = {
          version: 1, host: options.host, boot: options.boot, pid: process.pid, start: processStart(process.pid),
          attemptedAt: Date.now(), capturedAt: snapshot.at,
          savedAt: result.saved ? snapshot.at : health.savedAt || null,
          snapshotAt: result.snapshot.at, pending: result.reason || null, error: null,
        };
        atomicJson(config.stateDir, 'health.json', health);
        process.stdout.write(JSON.stringify({
          saved: result.saved, reason: result.reason, at: result.snapshot.at,
          exact: result.snapshot.programs.filter(program => program.state === 'exact').length,
        }) + '\n');
      } catch (error) {
        if (!stopped) {
          health = { ...health, version: 1, host: options.host, boot: options.boot,
            pid: process.pid, start: processStart(process.pid), attemptedAt: Date.now(), error: error.message };
          atomicJson(config.stateDir, 'health.json', health);
          process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
          if (values.once) process.exitCode = 1;
        }
      } finally {
        core?.close();
        core = undefined;
      }
      if (!values.once && !stopped) {
        await new Promise(resolve => {
          wake = resolve;
          timer = setTimeout(resolve, intervalMs);
        });
        wake = undefined;
      }
    } while (!values.once && !stopped);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
});
