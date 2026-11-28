'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { privateDirectory, readJson, atomicJson } = require('./store');
const { processStart } = require('./capture');
const { randomUUID } = require('node:crypto');

function paths(stateDir, terminal, nonce) {
  if (!/^t[0-9][a-z0-9]*$/.test(terminal)) throw new Error('Invalid local terminal identity.');
  if (nonce !== undefined && !/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Invalid approval identity.');
  return {
    pendingDir: path.join(stateDir, 'pending'),
    requestDir: path.join(stateDir, 'requests'),
    pendingName: `${terminal}.json`,
    requestName: nonce ? `${nonce}.json` : undefined,
  };
}

function registerPending(stateDir, value) {
  const target = paths(stateDir, value.terminal, value.nonce);
  privateDirectory(target.pendingDir);
  privateDirectory(target.requestDir);
  atomicJson(target.pendingDir, target.pendingName, value);
  return target;
}

function readPending(stateDir, terminal, { host, coreId }) {
  const target = paths(stateDir, terminal.address);
  const value = readJson(path.join(target.pendingDir, target.pendingName));
  if (!value) return null;
  if (value.version !== 1 || value.terminal !== terminal.address || value.host !== host
    || value.coreId !== coreId || value.pid !== terminal.pid || !value.start) {
    throw new Error('Pending recovery does not match the current host, core and process.');
  }
  paths(stateDir, terminal.address, value.nonce);
  let start;
  try { start = processStart(value.pid); } catch {
    throw new Error('Pending recovery process is unavailable.');
  }
  if (start !== value.start) throw new Error('Pending recovery process identity changed.');
  return value;
}

function requestResume(stateDir, pending, program) {
  const target = paths(stateDir, pending.terminal, pending.nonce);
  const request = path.join(target.requestDir, target.requestName);
  const temporary = path.join(target.requestDir, `.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify({
      version: 1, terminal: pending.terminal, host: pending.host, coreId: pending.coreId,
      nonce: pending.nonce, pid: pending.pid, start: pending.start, program,
    }) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // Link a complete file atomically without replacing an existing approval.
    fs.linkSync(temporary, request);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { registerPending, readPending, requestResume, pendingPaths: paths };
