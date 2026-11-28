#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { CoreClient } = require('../native/core');
const { readConfig, hostOptions, executable } = require('../native/config');
const { SnapshotStore, readJson } = require('../native/store');
const { registerPending } = require('../native/pending');
const { processStart } = require('../native/capture');
const { verifySession, launchDirectory } = require('../native/sessions');
const { resumeArgv, launchFor, throughLoginShell } = require('../native/identity');
const { toolArgv } = require('../native/tools');

function execute(argv, env = process.env) {
  if (typeof process.execve !== 'function') throw new Error('The shell hook needs Node 22.15 or newer.');
  const file = executable(argv[0], env);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  fs.writeSync(1, '\x1b]7501;{"status":"idle"}\x07');
  process.execve(file, argv, env);
}

// The wrapped shell, kept so any failure still opens a usable terminal.
let fallback = null;

async function main() {
  const { values, positionals: original } = parseArgs({
    options: { config: { type: 'string' } }, allowPositionals: true,
  });
  if (!original.length) throw new Error('The original shell command is required after --.');
  fallback = original;
  const config = readConfig(values.config);
  if ((process.env.HC_SESSION || 'default') !== config.session) return execute(original);
  const options = hostOptions(config);
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal || !/^t[0-9][a-z0-9]*$/.test(terminal)) return execute(original);
  const saved = new SnapshotStore(config.stateDir).load();
  const program = saved?.programs.find(item => item.terminal === terminal);
  if (!program || !['exact', 'tool'].includes(program.state)) return execute(original);
  if (!process.env.HC_TERMINAL_SOCKET) throw new Error('The parent terminal did not provide its core socket.');
  const core = new CoreClient({ socket: process.env.HC_TERMINAL_SOCKET });
  let hello;
  try { hello = await core.request('hello'); } finally { core.close(); }
  if (hello.core.id !== saved.core?.id || saved.host !== options.host) {
    process.stderr.write('Herdr recovery: core identity changed; saved commands were not resumed.\n');
    return execute(original);
  }
  const pending = {
    version: 1, terminal, host: options.host, coreId: hello.core.id,
    nonce: randomUUID(), pid: process.pid, start: processStart(process.pid),
  };
  const target = registerPending(config.stateDir, pending);
  const requestFile = path.join(target.requestDir, target.requestName);
  let executing = false;
  let watcher;
  const clear = () => {
    watcher?.close();
    const current = readJson(path.join(target.pendingDir, target.pendingName));
    if (current?.nonce === pending.nonce) fs.unlinkSync(path.join(target.pendingDir, target.pendingName));
    if (fs.existsSync(requestFile)) fs.unlinkSync(requestFile);
  };
  const accept = async () => {
    if (executing) return;
    const request = readJson(requestFile);
    if (!request) return;
    for (const key of ['terminal', 'host', 'coreId', 'nonce', 'pid', 'start']) {
      if (request[key] !== pending[key]) throw new Error('Recovery approval does not match this waiting terminal.');
    }
    if (request.version !== 1) throw new Error('Unsupported recovery approval.');
    executing = true;
    try {
      const next = request.program;
      const launch = launchFor(next, next.state === 'exact' ? resumeArgv(next) : toolArgv(next), { ...process.env });
      const { argv, env } = launch;
      const session = next.state === 'exact' ? await verifySession(next, { env }) : undefined;
      const cwd = launchDirectory(next, session);
      if (!cwd) throw new Error('No saved working directory exists.');
      process.chdir(cwd);
      clear();
      // Start it through this terminal's own shell, so its configuration loads.
      let shell = null;
      try { shell = executable(original[0], env); } catch { /* run without a login shell */ }
      execute(shell ? throughLoginShell(argv, shell, env) : argv, env);
    } catch (error) {
      executing = false;
      if (fs.existsSync(requestFile)) fs.unlinkSync(requestFile);
      process.stderr.write(`Herdr recovery remains pending: ${error.message}\n`);
    }
  };
  watcher = fs.watch(target.requestDir, () => {
    accept().catch(error => process.stderr.write(`Herdr recovery: ${error.message}\n`));
  });
  process.stdout.write('\x1b]7501;{"app":"herdr-resurrect","status":"blocked"}\x07');
  process.stdout.write(`Recovery is waiting for ${program.tool}.\nPreview and approve it in Herdr Resurrect.\n`
    + 'Press Enter to open an empty shell without discarding the saved snapshot.\n');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', bytes => {
    if (!executing && (bytes.includes(13) || bytes.includes(10))) {
      executing = true;
      clear();
      execute(original);
    }
  });
  process.stdin.resume();
  await accept();
}

main().catch(error => {
  process.stderr.write(`Herdr recovery shell failed: ${error.message}\n`);
  const shell = fallback;
  fallback = null;
  if (shell) {
    process.stderr.write('Opening the shell without recovery.\n');
    try { return execute(shell); } catch (failure) {
      process.stderr.write(`Herdr recovery could not start the shell: ${failure.message}\n`);
    }
  }
  process.exitCode = 1;
});
