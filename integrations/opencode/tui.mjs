// Adapted from Delphos-Labs/tmux-assistant-resurrect, hooks/opencode-session-track.js (MIT).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

function defaultStateDirectory() {
  if (process.env.HERDR_RESURRECT_AGENT_DIR) return process.env.HERDR_RESURRECT_AGENT_DIR;
  const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'herdr-resurrect', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config.version !== 1 || !path.isAbsolute(config.opencodeStateDir || '')) {
      throw new Error('Unsupported host recorder configuration.');
    }
    return config.opencodeStateDir;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'herdr-resurrect', 'agents');
}

export function SessionTracker(context, {
  stateDir,
  pollMs = 1000,
  report = message => console.error(`[herdr-resurrect] ${message}`),
} = {}) {
  let recorded;
  let lastError;
  let start;
  let file;
  let timer;
  let wrote = false;
  let unsubscribe = () => {};
  const error = cause => {
    const message = cause.message || String(cause);
    if (message !== lastError) report(`Session tracking failed: ${message}`);
    lastError = message;
  };
  try {
    stateDir ??= defaultStateDirectory();
    if (process.platform !== 'linux') throw new Error('This tracker version requires Linux.');
    if (!path.isAbsolute(stateDir)) throw new Error('Tracker directory must be absolute.');
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    start = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
    if (!start) throw new Error('Cannot identify this process lifetime.');
    file = path.join(stateDir, `opencode-${process.pid}.json`);
  } catch (cause) {
    error(cause);
    return { sync() {}, dispose() {} };
  }
  const sync = (force = false) => {
    try {
      const route = context.ui.router.current();
      if (route?.type !== 'session' || !route.sessionID) return;
      const session = context.data.session.root(route.sessionID) || route.sessionID;
      const location = context.location ?? context.data.location.default();
      const cwd = location?.directory;
      const created = context.data.session.get?.(session)?.time?.created;
      if (!/^ses_[A-Za-z0-9_-]+$/.test(session) || !path.isAbsolute(cwd || '')) {
        throw new Error('The current session or directory is invalid.');
      }
      const identity = `${session}\n${cwd}\n${created ?? ''}`;
      if (!force && identity === recorded) return;
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const directory = fs.lstatSync(stateDir);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()) {
        throw new Error('Unsafe tracker directory.');
      }
      if (directory.mode & 0o077) fs.chmodSync(stateDir, 0o700);
      const temporary = path.join(stateDir, `.opencode-${process.pid}-${randomUUID()}.tmp`);
      let fd;
      try {
        fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL
          | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, JSON.stringify({
          tool: 'opencode', pid: process.pid, process_start: start,
          session_id: session, cwd, timestamp: new Date().toISOString(),
          ...(Number.isFinite(created) ? { session_created: created } : {}),
        }) + '\n');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, file);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
      recorded = identity;
      wrote = true;
      lastError = undefined;
    } catch (cause) {
      error(cause);
    }
  };
  if (pollMs > 0) {
    timer = setInterval(sync, pollMs);
    timer.unref();
  }
  unsubscribe = context.data.on('session.execution.succeeded', () => sync(true));
  const cleanup = () => {
    if (!wrote) return;
    let fd;
    try {
      const directory = fs.lstatSync(stateDir);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()) {
        throw new Error('Refusing cleanup through an unsafe tracker directory.');
      }
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (record.pid !== process.pid || record.process_start !== start
        || `${record.session_id}\n${record.cwd}\n${record.session_created ?? ''}` !== recorded) return;
      fs.unlinkSync(file);
      wrote = false;
    } catch (cause) {
      if (cause.code !== 'ENOENT') error(cause);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  process.on('exit', cleanup);
  sync();
  return {
    sync,
    dispose() {
      clearInterval(timer);
      unsubscribe();
      process.removeListener('exit', cleanup);
      cleanup();
    },
  };
}

export default {
  id: 'herdr-resurrect-session',
  setup(context) {
    return SessionTracker(context).dispose;
  },
};
