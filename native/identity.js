'use strict';

const fs = require('node:fs');
const os = require('node:os');
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

// Claude reads ~/.claude.json while CLAUDE_CONFIG_DIR is unset, and
// $CLAUDE_CONFIG_DIR/.claude.json once it is set, even to ~/.claude. A launch
// must therefore repeat whether the original process set the variable, not
// only which directory it used. Snapshots older than profileExplicit record
// the default directory for an unset variable.
function launchFor(program, argv, env, home = os.homedir()) {
  if (program.tool !== 'claude' || !program.profile) return { argv, env };
  const explicit = typeof program.profileExplicit === 'boolean'
    ? program.profileExplicit : path.resolve(program.profile) !== path.join(home, '.claude');
  if (explicit) {
    return { argv: ['env', `CLAUDE_CONFIG_DIR=${program.profile}`, ...argv], env: { ...env, CLAUDE_CONFIG_DIR: program.profile } };
  }
  const { CLAUDE_CONFIG_DIR: _unset, ...rest } = env;
  return { argv: ['env', '-u', 'CLAUDE_CONFIG_DIR', ...argv], env: rest };
}

// The core and its gateway start outside any login shell, so a restored
// program would miss what the user's shell configuration exports, such as API
// keys. Start it through the login shell, which then replaces itself with it.
// A login profile can reset PATH, so the program is resolved first: the
// wrapper adds the shell's environment without changing which program runs.
function throughLoginShell(argv, shell = os.userInfo().shell, env = process.env) {
  const name = path.basename(shell || '');
  if (!path.isAbsolute(shell || '')) return argv;
  if (name === 'fish') return [shell, '-l', '-c', 'exec $argv', '--', ...resolveProgram(argv, env)];
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name)) {
    return [shell, '-l', '-c', 'exec "$@"', name, ...resolveProgram(argv, env)];
  }
  return argv;
}

function resolveProgram(argv, env) {
  const result = [...argv];
  let index = 0;
  if (path.basename(result[0] || '') === 'env') {
    index = 1;
    while (index < result.length) {
      if (result[index] === '-u') index += 2;
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(result[index])) index += 1;
      else break;
    }
    result[0] = which(result[0], env) || result[0];
  }
  if (index < result.length) result[index] = which(result[index], env) || result[index];
  return result;
}

function which(name, env) {
  if (path.isAbsolute(name) || name.includes('/')) return name;
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* next */ }
  }
  return null;
}

module.exports = { resolveIdentity, readIdentity, resumeArgv, launchFor, throughLoginShell };
