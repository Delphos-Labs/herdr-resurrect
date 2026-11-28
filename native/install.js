'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { execFileSync } = require('node:child_process');
const { parse: parseToml } = require('smol-toml');
const { executable, validateConfig } = require('./config');
const { privateDirectory, atomicJson } = require('./store');

const hash = value => createHash('sha256').update(value).digest('hex');

function readExisting(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('Installation target is not a regular file owned by this user.');
    }
    const content = fs.readFileSync(file, 'utf8');
    return { content, digest: hash(content) };
  } catch (error) {
    if (error.code === 'ENOENT') return { content: '', digest: null };
    throw error;
  }
}

function shellPatch(text, gateway, fallback) {
  const parsed = parseToml(text);
  const original = parsed.shell || fallback;
  if (!Array.isArray(original) || !original.length || original.some(value => typeof value !== 'string')) {
    throw new Error('The existing core shell is not a supported command array.');
  }
  if (original.some(value => ['herdr-wake', 'native-shell.js', 'native-shell.sh'].includes(path.basename(value)))) {
    throw new Error('A recovery shell hook is already configured. Do not nest recovery engines.');
  }
  if (path.basename(original[0]) === 'tmux') throw new Error('Choose a real shell before replacing tmux.');
  const line = `shell = ${JSON.stringify([...gateway, '--', ...original])}`;
  let content;
  if (parsed.shell === undefined) content = line + '\n' + text;
  else {
    const lines = text.split('\n');
    const table = lines.findIndex(value => /^\s*\[/.test(value));
    const candidates = lines.map((value, index) => ({ value, index }))
      .filter(item => (table < 0 || item.index < table) && /^\s*shell\s*=/.test(item.value));
    if (candidates.length !== 1 || !/^\s*shell\s*=\s*\[.*\]\s*(?:#.*)?$/.test(candidates[0].value)) {
      throw new Error('Automatic installation supports a single-line top-level shell setting. Review a manual edit instead.');
    }
    const comment = candidates[0].value.match(/\]\s*(#.*)$/)?.[1];
    lines[candidates[0].index] = line + (comment ? ' ' + comment : '');
    content = lines.join('\n');
  }
  const after = parseToml(content);
  delete parsed.shell;
  delete after.shell;
  if (!isDeepStrictEqual(parsed, after)) throw new Error('Core configuration changed outside its shell setting.');
  return { content, original };
}

function systemdArgument(value, { environment = false } = {}) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new Error('Unsupported service argument.');
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return `"${environment ? escaped : escaped.replaceAll('$', () => '$$')}"`;
}

const unitPath = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n\s]/.test(value)) {
    throw new Error('Unsupported path for a systemd condition.');
  }
  return value.replaceAll('%', '%%');
};

// The path unit starts the recorder, so it never runs before Herdr Core is
// installed: on a new machine the core arrives when the app first connects.
function serviceUnit({ node = 'auto', prefix, configFile, home, env, hc }) {
  const environment = Object.entries(env).map(([key, value]) =>
    `Environment=${systemdArgument(`${key}=${value}`, { environment: true })}`).join('\n');
  const command = ['/bin/sh', path.join(prefix, 'bin/native-shell.sh'), node,
    path.join(prefix, 'bin/native-recorder.js'), '--config', configFile];
  return `[Unit]\nDescription=Record native Herdr recovery state\nStartLimitIntervalSec=60\nStartLimitBurst=3\n`
    + (hc ? `ConditionPathExists=${unitPath(hc)}\n` : '') + '\n'
    + `[Service]\nType=simple\nUMask=0077\nWorkingDirectory=${home.replaceAll('%', '%%')}\n${environment}\n`
    + 'UnsetEnvironment=HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SCOPE\n'
    + `ExecStart=${command.map(value => systemdArgument(value)).join(' ')}\n`
    + 'Restart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\nNoNewPrivileges=yes\n';
}

function pathUnit({ hc }) {
  return '[Unit]\nDescription=Start Herdr recovery once Herdr Core is installed\n\n'
    + `[Path]\nPathExists=${unitPath(hc)}\nUnit=herdr-resurrect.service\n\n`
    + '[Install]\nWantedBy=default.target\n';
}

function defaultHc(home, env) {
  try { return executable('hc', env); } catch {
    return path.join(env.HC_INSTALL_DIR || path.join(home, '.local/bin'), 'hc');
  }
}

// Mirrors native-shell.sh "auto": mise's Node for the home directory, else PATH.
function resolveNode(home, env) {
  try {
    const found = execFileSync('mise', ['which', 'node'], { cwd: home, env, encoding: 'utf8', timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (path.isAbsolute(found)) return found;
  } catch { /* fall back to PATH */ }
  return executable('node', env);
}

function packageFiles(packageRoot) {
  const result = [];
  function visit(relative) {
    const source = path.join(packageRoot, relative);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error('Package source contains an unexpected symlink.');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(source).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      result.push({ relative, digest: hash(fs.readFileSync(source)) });
    } else throw new Error('Unsupported package source type.');
  }
  for (const item of [
    'native', 'integrations/opencode', 'mods/resurrect', 'LICENSE', 'package.json',
    'bin/native-control.js', 'bin/native-recorder.js', 'bin/native-shell.js', 'bin/native-shell.sh',
    'bin/native-install.js', 'bin/herdr-resurrect',
  ]) visit(item);
  // A release tarball bundles its dependencies but never carries the lock file.
  if (!fs.existsSync(path.join(packageRoot, 'package-lock.json'))) {
    visit('node_modules');
    return result;
  }
  visit('package-lock.json');
  const lock = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package-lock.json')));
  for (const key of Object.keys(lock.packages || {}).sort()) {
    if (!key) continue;
    if (!key.startsWith('node_modules/') || key.includes('..') || path.isAbsolute(key)) {
      throw new Error('Unsupported dependency path in package lock.');
    }
    visit(key);
  }
  return result;
}

function planInstall({
  home = os.homedir(), configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
  stateHome = process.env.XDG_STATE_HOME || path.join(home, '.local/state'),
  dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local/share'),
  packageRoot = path.resolve(__dirname, '..'), prefix = path.join(dataHome, 'herdr-resurrect/current'),
  node = 'auto', hc, session = 'default', intervalMs = 60000,
  shell = [process.env.SHELL || '/bin/sh'], env = process.env,
} = {}) {
  hc ||= defaultHc(home, env);
  for (const value of [home, configHome, stateHome, dataHome, packageRoot, prefix, hc]) {
    if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Installation paths must be absolute.');
  }
  if (node !== 'auto' && (!path.isAbsolute(node) || /[\0\r\n]/.test(node))) throw new Error('Installation paths must be absolute.');
  if (fs.existsSync(prefix)) throw new Error('The installation destination already exists; no automatic overwrite is allowed.');
  const checkNode = node === 'auto' ? resolveNode(home, env) : node;
  if (execFileSync(checkNode, ['-p', 'typeof process.execve'], { encoding: 'utf8', timeout: 10000 }).trim() !== 'function') {
    throw new Error('The selected Node executable needs process.execve (Node 22.15 or newer).');
  }
  const configFile = path.join(configHome, 'herdr-resurrect/config.json');
  const config = {
    version: 1, stateDir: path.join(stateHome, 'herdr-resurrect/snapshots'),
    opencodeStateDir: path.join(stateHome, 'herdr-resurrect/agents'),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    hc, session, intervalMs,
    installDir: prefix,
    ...(env.HC_SOCKET ? { socket: env.HC_SOCKET } : {}),
  };
  validateConfig(config);
  const configCore = path.join(configHome, 'herdr-core/config.toml');
  const current = readExisting(configCore);
  // /bin/sh launches the gateway, so a missing Node still opens the plain shell.
  const patch = shellPatch(current.content, [
    '/bin/sh', path.join(prefix, 'bin/native-shell.sh'),
    node, path.join(prefix, 'bin/native-shell.js'), '--config', configFile,
  ], shell);
  const cli = path.join(configHome, 'opencode/cli.json');
  const oldCli = readExisting(cli);
  let preferences;
  try { preferences = JSON.parse(oldCli.content || '{}'); } catch {
    throw new Error('OpenCode CLI preferences are not strict JSON; register the tracker manually instead of rewriting comments.');
  }
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw new Error('OpenCode CLI preferences must be a JSON object.');
  }
  if (preferences.plugins !== undefined && !Array.isArray(preferences.plugins)) throw new Error('Unsupported CLI plugin list.');
  const plugin = path.join(prefix, 'integrations/opencode');
  preferences.plugins = [...(preferences.plugins || [])];
  if (!preferences.plugins.includes(plugin)) preferences.plugins.push(plugin);
  const indent = oldCli.content.match(/\n([ \t]+)\S/)?.[1] || '  ';
  const newline = oldCli.content.includes('\r\n') ? '\r\n' : '\n';
  const bootEnv = {
    HOME: home, PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, XDG_DATA_HOME: dataHome,
    ...(env.LANG ? { LANG: env.LANG } : {}),
  };
  const unitFile = path.join(configHome, 'systemd/user/herdr-resurrect.service');
  const pathFile = path.join(configHome, 'systemd/user/herdr-resurrect.path');
  const files = [
    { path: configFile, content: JSON.stringify(config, null, 2) + '\n' },
    { path: configCore, content: patch.content },
    { path: cli, content: JSON.stringify(preferences, null, indent).replaceAll('\n', newline) + newline },
    { path: unitFile, content: serviceUnit({ node, prefix, configFile, home, env: bootEnv, hc }) },
    { path: pathFile, content: pathUnit({ hc }) },
  ].map(file => ({ ...file, before: readExisting(file.path).digest }));
  return {
    version: 1, home, configHome, packageRoot, prefix, files, source: packageFiles(packageRoot),
    options: {
      home, configHome, stateHome, dataHome, packageRoot, prefix, node, hc, session, intervalMs, shell,
      env: { ...bootEnv, CLAUDE_CONFIG_DIR: config.claudeConfigDir,
        ...(config.socket ? { HC_SOCKET: config.socket } : {}) },
    },
    originalShell: patch.original, configFile, unitFile, pathFile,
    commands: [['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'herdr-resurrect.path']],
  };
}

function applyInstall(plan, { activate = false } = {}) {
  if (plan.version !== 1 || fs.existsSync(plan.prefix)) throw new Error('Installation destination is not empty or plan is invalid.');
  if (!plan.options || plan.packageRoot !== path.resolve(__dirname, '..')) {
    throw new Error('The installation plan does not match this package and local executables.');
  }
  if (!isDeepStrictEqual(planInstall(plan.options), plan)) {
    throw new Error('The installation plan changed or its configuration is stale; generate a new plan.');
  }
  if (activate) {
    const actualConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    if (plan.home !== os.homedir() || plan.home !== os.userInfo().homedir || plan.configHome !== actualConfigHome
      || process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR !== `/run/user/${process.getuid()}`) {
      throw new Error('Activation requires the actual user home and systemd runtime, not a staging environment.');
    }
  }
  let manager = false;
  if (activate) {
    try {
      execFileSync('systemctl', ['--user', 'is-active', 'default.target'], { stdio: 'pipe', timeout: 10000 });
      manager = true;
    } catch { /* enabled on disk below; the manager starts it at its next start */ }
  }
  for (const file of plan.files) {
    if (readExisting(file.path).digest !== file.before) throw new Error('Configuration changed after planning; generate a new plan.');
  }
  if (!isDeepStrictEqual(packageFiles(plan.packageRoot), plan.source)) {
    throw new Error('Package source changed after planning; generate a new plan.');
  }
  fs.mkdirSync(path.dirname(plan.prefix), { recursive: true });
  fs.mkdirSync(plan.prefix, { mode: 0o700 });
  for (const item of plan.source) {
    const target = path.join(plan.prefix, item.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(plan.packageRoot, item.relative), target, fs.constants.COPYFILE_EXCL);
  }
  const record = path.join(plan.prefix, '.installation');
  privateDirectory(record);
  for (const [index, file] of plan.files.entries()) {
    const previous = readExisting(file.path);
    if (previous.digest !== file.before) throw new Error('Configuration changed during installation; review the partial installation.');
    if (previous.digest !== null) {
      fs.writeFileSync(path.join(record, `before-${index}`), previous.content, { flag: 'wx', mode: 0o600 });
    }
    fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file.path), `.${path.basename(file.path)}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, file.content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, file.path);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  atomicJson(record, 'manifest.json', {
    version: 1, configFile: plan.configFile, unitFile: plan.unitFile,
    files: plan.files.map(file => ({ path: file.path, before: file.before, installed: hash(file.content) })),
  });
  const warnings = [];
  if (activate && manager) for (const [command, ...args] of plan.commands) {
    execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  } else if (activate) {
    // A provisioning run can precede the user manager. Enabling is a symlink.
    const wants = path.join(path.dirname(plan.pathFile), 'default.target.wants');
    fs.mkdirSync(wants, { recursive: true, mode: 0o700 });
    const link = path.join(wants, path.basename(plan.pathFile));
    try { fs.symlinkSync(plan.pathFile, link); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    warnings.push('The systemd user manager is not running; recovery is enabled and starts with it.');
  }
  if (activate) {
    let linger = '';
    try {
      linger = execFileSync('loginctl', ['show-user', String(process.getuid()), '-p', 'Linger'], {
        encoding: 'utf8', timeout: 10000,
      }).trim();
    } catch { /* reported below */ }
    if (linger !== 'Linger=yes') {
      warnings.push('User lingering is off, so recovery starts only at login. Herdr Core enables it when it starts.');
    }
  }
  return { installed: true, activated: activate, prefix: plan.prefix, configFile: plan.configFile, warnings };
}

function isInside(file, directory) {
  const relative = path.relative(directory, file || '');
  return Boolean(file) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Reverses applyInstall. Every file must still hold exactly what was installed,
// so a later manual edit is never overwritten; nothing changes if one differs.
function uninstall(prefix, { deactivate = true, run = execFileSync } = {}) {
  const record = path.join(prefix, '.installation');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(record, 'manifest.json'), 'utf8')); } catch {
    throw new Error('No installation manifest found; nothing was changed.');
  }
  // systemctl acts on unit names in the account's real manager. Only touch it
  // when the installation's units live under the account's real home.
  if (deactivate && !isInside(manifest.unitFile, os.userInfo().homedir)) deactivate = false;
  const steps = manifest.files.map((file, index) => {
    const current = readExisting(file.path);
    if (current.digest !== file.installed) {
      throw new Error(`${file.path} changed after installation; restore it by hand. Nothing was changed.`);
    }
    const before = file.before === null ? null : fs.readFileSync(path.join(record, `before-${index}`), 'utf8');
    if (before !== null && hash(before) !== file.before) throw new Error(`Saved copy of ${file.path} is damaged.`);
    return { path: file.path, before };
  });
  if (deactivate) {
    // Installations before the path unit have no herdr-resurrect.path.
    try {
      run('systemctl', ['--user', 'disable', '--now', 'herdr-resurrect.path'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    } catch { /* not installed by that version */ }
    run('systemctl', ['--user', 'disable', '--now', 'herdr-resurrect.service'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  }
  for (const step of steps) {
    if (step.before === null) fs.rmSync(step.path, { force: true });
    else {
      const temporary = path.join(path.dirname(step.path), `.${path.basename(step.path)}.${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, step.before, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, step.path);
    }
  }
  for (const unit of manifest.files.map(file => file.path).filter(file => file.endsWith('.path'))) {
    const link = path.join(path.dirname(unit), 'default.target.wants', path.basename(unit));
    try { if (fs.readlinkSync(link) === unit) fs.unlinkSync(link); } catch { /* no offline enable link */ }
  }
  if (deactivate) run('systemctl', ['--user', 'daemon-reload'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  fs.rmSync(prefix, { recursive: true, force: true });
  return { uninstalled: true, restored: steps.map(step => step.path) };
}

// One idempotent command for dotfiles and upgrades: install when absent, do
// nothing when the installed copy matches this package, otherwise replace it.
function install({ activate = false, run = execFileSync, ...options } = {}) {
  const home = options.home || os.homedir();
  const dataHome = options.dataHome || process.env.XDG_DATA_HOME || path.join(home, '.local/share');
  const prefix = options.prefix || path.join(dataHome, 'herdr-resurrect/current');
  const packageRoot = options.packageRoot || path.resolve(__dirname, '..');
  let changed = true;
  if (fs.existsSync(prefix)) {
    let same = false;
    try { same = isDeepStrictEqual(packageFiles(prefix), packageFiles(packageRoot)); } catch { same = false; }
    if (same) return { installed: true, changed: false, prefix };
    uninstall(prefix, { deactivate: activate, run });
  }
  const plan = planInstall({ ...options, home, dataHome, prefix, packageRoot });
  return { ...applyInstall(plan, { activate }), changed };
}

module.exports = { planInstall, applyInstall, install, uninstall, shellPatch, serviceUnit, pathUnit, packageFiles };
