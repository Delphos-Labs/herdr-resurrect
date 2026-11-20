'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SESSION_IDS = {
  opencode: /^ses_[A-Za-z0-9_-]+$/,
  claude: /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,
};

function resolveIdentity(processInfo, record) {
  if (!SESSION_IDS[processInfo.tool]) return { state: 'unsupported', reason: 'Unsupported agent.' };
  if (!Number.isInteger(processInfo.pid) || processInfo.pid <= 0
    || processInfo.start === undefined || processInfo.start === null || processInfo.start === '') {
    return { state: 'unresolved', reason: 'No live process-lifetime evidence.' };
  }
  if (!record) return { state: 'unresolved', reason: 'No process-specific session record.' };
  if (Number(record.pid) !== processInfo.pid) {
    return { state: 'unresolved', reason: 'Session record belongs to another process.' };
  }
  const start = record.procStart ?? record.process_start;
  if (!start || String(start) !== String(processInfo.start)) {
    return { state: 'unresolved', reason: 'Missing or stale process-lifetime evidence.' };
  }
  const session = record.sessionId ?? record.session_id;
  if (typeof session !== 'string' || !SESSION_IDS[processInfo.tool].test(session)) {
    return { state: 'unresolved', reason: 'Invalid conversation identifier.' };
  }
  if (record.tool && record.tool !== processInfo.tool) {
    return { state: 'unresolved', reason: 'Session record names another agent.' };
  }
  return { state: 'exact', tool: processInfo.tool, session, evidence: 'pid-and-process-start',
    ...(Number.isFinite(record.session_created) ? { sessionCreated: record.session_created } : {}),
    ...(typeof record.cwd === 'string' && path.isAbsolute(record.cwd) ? { cwd: record.cwd } : {}) };
}

function readRecord(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid session record file.');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Session record belongs to another user.');
    }
    try { return JSON.parse(fs.readFileSync(fd, 'utf8')); } catch (error) {
      if (error instanceof SyntaxError) throw new SyntaxError('Invalid process-session record JSON.');
      throw error;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readIdentity(processInfo, { opencodeStateDir, claudeConfigDir }) {
  try {
    if (!SESSION_IDS[processInfo.tool]) return { state: 'unsupported', reason: 'Unsupported agent.' };
    const directory = processInfo.tool === 'opencode' ? opencodeStateDir : claudeConfigDir;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      return { state: 'unresolved', reason: 'No absolute agent record directory configured.' };
    }
    const file = processInfo.tool === 'opencode'
      ? path.join(directory, `opencode-${processInfo.pid}.json`)
      : path.join(directory, 'sessions', `${processInfo.pid}.json`);
    return resolveIdentity(processInfo, readRecord(file));
  } catch (error) {
    return { state: 'unresolved', reason: `Cannot read session record: ${error.code || error.message}` };
  }
}

function resumeArgv(identity) {
  if (identity.state !== 'exact' || !SESSION_IDS[identity.tool]?.test(identity.session)) {
    throw new Error('An exact, valid conversation identity is required.');
  }
  return identity.tool === 'opencode'
    ? ['opencode', '-s', identity.session]
    : ['claude', '--resume', identity.session];
}

module.exports = { resolveIdentity, readIdentity, resumeArgv };
