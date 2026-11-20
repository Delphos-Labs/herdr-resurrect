'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CoreClient } = require('../../native/core');

function isolatedCore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(HC_|HERDR_|TMUX)/.test(key)));
  Object.assign(env, {
    HC_SESSION: 'proof',
    XDG_RUNTIME_DIR: path.join(root, 'run'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
  });
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const hc = process.env.HERDR_TEST_HC || 'hc';
  let started = false;
  let client;
  const cleanups = [];
  const command = args => JSON.parse(execFileSync(hc, args, {
    env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup();
    } finally {
      client?.close();
      try {
        if (started) command(['server', 'stop']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
  const status = command(['server', 'start']);
  started = true;
  client = new CoreClient({ binary: hc, env });
  return { root, env, hc, command, client, coreId: status.core.id,
    beforeStop: cleanup => cleanups.push(cleanup) };
}

async function duringFileEvent(file, action, predicate = () => true, timeoutMs = 10000) {
  const directory = path.dirname(file);
  let watcher;
  let timer;
  let done;
  const ready = new Promise((resolve, reject) => {
    done = resolve;
    watcher = fs.watch(directory, () => {
      if (fs.existsSync(file) && predicate()) resolve();
    });
    watcher.on('error', reject);
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${file}.`)), timeoutMs);
  });
  // Attach a rejection handler before starting the asynchronous action.
  ready.catch(() => {});
  try {
    const result = await action();
    if (fs.existsSync(file) && predicate()) done();
    await ready;
    return result;
  } finally {
    watcher.close();
    clearTimeout(timer);
  }
}

module.exports = { isolatedCore, duringFileEvent };
