'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const lockfile = require('proper-lockfile');
const { validateLayout } = require('./layout');

function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('State directory must be absolute.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe state directory.');
  if (typeof process.getuid === 'function') {
    if (stat.uid !== process.getuid()) throw new Error('State directory belongs to another user.');
    if (stat.mode & 0o077) fs.chmodSync(directory, 0o700);
  }
}

function readJson(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid snapshot file.');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('State file belongs to another user.');
    }
    try { return JSON.parse(fs.readFileSync(fd, 'utf8')); } catch (error) {
      if (error instanceof SyntaxError) throw new SyntaxError('Invalid private recovery-state JSON.');
      throw error;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicJson(directory, name, value, beforeRename = () => {}) {
  if (path.basename(name) !== name || name === '.' || name === '..') throw new Error('Invalid state filename.');
  const target = path.join(directory, name);
  const temp = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    beforeRename();
    fs.renameSync(temp, target);
    if (process.platform !== 'win32') {
      const parent = fs.openSync(directory, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function validateSnapshot(value) {
  if (value?.format !== 1 || typeof value.host !== 'string' || !value.host
    || typeof value.boot !== 'string' || !value.boot || !Number.isFinite(value.at)
    || !Array.isArray(value.programs)) throw new Error('Unsupported snapshot.');
  const references = new Set(validateLayout(value.layout));
  const seen = new Set();
  for (const program of value.programs) {
    if (!references.has(program.terminal) || seen.has(program.terminal)
      || !['exact', 'tool', 'unresolved', 'unsupported', 'shell'].includes(program.state)) {
      throw new Error('Invalid snapshot program record.');
    }
    seen.add(program.terminal);
  }
  if (seen.size !== references.size) throw new Error('Snapshot is missing program records.');
  return value;
}

function snapshotDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertRecovered(saved, fresh) {
  const programs = snapshot => {
    const byTerminal = new Map(snapshot.programs.map(program => [program.terminal, program]));
    const byPane = new Map();
    function visit(node) {
      if (node.type === 'block') byPane.set(node.id, byTerminal.get(node.content.terminal));
      else node.children.forEach(visit);
    }
    for (const space of snapshot.layout.spaces) for (const tab of space.tabs) visit(tab.root);
    return byPane;
  };
  const current = programs(fresh);
  for (const [pane, wanted] of programs(saved)) {
    const actual = current.get(pane);
    if (!actual || actual.observed || actual.state !== wanted.state) {
      throw new Error(`Recovery is not verified for pane ${pane}.`);
    }
    if (wanted.state === 'shell') continue;
    if (!['exact', 'tool'].includes(wanted.state) || actual.tool !== wanted.tool
      || path.resolve(actual.cwd || '/') !== path.resolve(wanted.cwd || '/')) {
      throw new Error(`Saved program is not verified for pane ${pane}.`);
    }
    if (wanted.state === 'exact' && actual.session !== wanted.session) {
      throw new Error(`Conversation changed for pane ${pane}.`);
    }
    if (wanted.sessionCreated !== undefined && actual.sessionCreated !== wanted.sessionCreated) {
      throw new Error(`Conversation instance changed for pane ${pane}.`);
    }
    if (wanted.tool === 'tuicr'
      && (wanted.review?.session.id !== actual.review?.session.id
        || wanted.review?.sha256 !== actual.review?.sha256)) {
      throw new Error(`Review identity changed for pane ${pane}.`);
    }
    if (wanted.tool === 'gh-dash' && JSON.stringify(wanted.config) !== JSON.stringify(actual.config)) {
      throw new Error(`Dashboard configuration changed for pane ${pane}.`);
    }
  }
}

class SnapshotStore {
  constructor(directory, { retain = 60, beforeRename } = {}) {
    if (!Number.isInteger(retain) || retain < 1) throw new Error('Invalid snapshot retention.');
    this.directory = directory;
    this.retain = retain;
    this.beforeRename = beforeRename;
    privateDirectory(directory);
  }

  load() {
    const value = readJson(path.join(this.directory, 'last.json'));
    return value === null ? null : validateSnapshot(value);
  }

  list() {
    return fs.readdirSync(this.directory)
      .filter(file => /^snapshot-\d+-[a-f0-9-]+\.json$/.test(file))
      .map(file => ({ name: file, snapshot: validateSnapshot(readJson(path.join(this.directory, file))) }))
      .sort((a, b) => b.snapshot.at - a.snapshot.at);
  }

  save(value, { reconciledAgainst } = {}) {
    validateSnapshot(value);
    const release = lockfile.lockSync(this.directory, {
      lockfilePath: path.join(this.directory, '.capture.lock'), stale: 10000, update: 5000,
    });
    try {
      const previous = this.load();
      if (previous && previous.host !== value.host) throw new Error('Snapshot host identity changed.');
      if (previous && value.at <= previous.at) throw new Error('Capture is older than the saved state.');
      const protectedWork = previous?.programs.some(p => p.state !== 'shell');
      const recoveryShells = value.programs.every(p => p.state === 'shell');
      const ended = new Map((value.ended || []).map(item => [item.terminal, item]));
      const intentionallyClosed = previous && previous.boot === value.boot
        && previous.programs.filter(program => program.state !== 'shell').every(program => {
          const terminal = ended.get(program.terminal);
          return terminal && (terminal.reason === 'killed'
            || terminal.reason === 'exited' && terminal.exitCode === 0);
        });
      if (reconciledAgainst) {
        if (!previous || snapshotDigest(previous) !== reconciledAgainst) {
          throw new Error('The saved recovery state changed; verify again.');
        }
        assertRecovered(previous, value);
      }
      if (previous && previous.boot !== value.boot && protectedWork && !reconciledAgainst) {
        return { saved: false, reason: 'recovery-pending', snapshot: previous };
      }
      if (protectedWork && recoveryShells && !intentionallyClosed) {
        return { saved: false, reason: 'empty-state-needs-confirmation', snapshot: previous };
      }
      const known = new Map((previous?.programs || []).map(program => [program.terminal, program]));
      value = {
        ...value,
        programs: value.programs.map(program => {
          const saved = known.get(program.terminal);
          if (!['exact', 'tool'].includes(saved?.state) || ['exact', 'tool'].includes(program.state)) return program;
          return {
            ...saved, verified_at: saved.verified_at ?? previous.at,
            observed: { state: program.state, reason: program.reason },
          };
        }),
      };
      const name = `snapshot-${value.at}-${randomUUID()}.json`;
      atomicJson(this.directory, name, value);
      atomicJson(this.directory, 'last.json', value, this.beforeRename);
      const versions = fs.readdirSync(this.directory)
        .filter(file => /^snapshot-\d+-[a-f0-9-]+\.json$/.test(file))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]) || a.localeCompare(b));
      for (const old of versions.slice(this.retain)) fs.unlinkSync(path.join(this.directory, old));
      return { saved: true, snapshot: value };
    } finally {
      release();
    }
  }
}

module.exports = {
  SnapshotStore, validateSnapshot, privateDirectory, readJson, atomicJson, snapshotDigest, assertRecovered,
};
