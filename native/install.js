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

function serviceUnit({ node, prefix, configFile, home, env }) {
  const environment = Object.entries(env).map(([key, value]) =>
    `Environment=${systemdArgument(`${key}=${value}`, { environment: true })}`).join('\n');
  return `[Unit]\nDescription=Record native Herdr recovery state\nStartLimitIntervalSec=60\nStartLimitBurst=3\n\n`
    + `[Service]\nType=simple\nUMask=0077\nWorkingDirectory=${home.replaceAll('%', '%%')}\n${environment}\n`
    + 'UnsetEnvironment=HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SCOPE\n'
    + `ExecStart=${[node, path.join(prefix, 'bin/native-recorder.js'), '--config', configFile].map(value => systemdArgument(value)).join(' ')}\n`
    + 'Restart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\nNoNewPrivileges=yes\n\n'
    + '[Install]\nWantedBy=default.target\n';
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
    'native', 'integrations/opencode', 'mods/resurrect', 'LICENSE', 'package.json', 'package-lock.json',
    'bin/native-control.js', 'bin/native-recorder.js', 'bin/native-shell.js', 'bin/native-shell.sh',
    'bin/native-install.js',
  ]) visit(item);
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
  node = executable('node'), hc = executable('hc'), session = 'default', intervalMs = 60000,
  shell = [process.env.SHELL || '/bin/sh'], env = process.env,
} = {}) {
  for (const value of [home, configHome, stateHome, dataHome, packageRoot, prefix, node, hc]) {
    if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Installation paths must be absolute.');
  }
  if (fs.existsSync(prefix)) throw new Error('The installation destination already exists; no automatic overwrite is allowed.');
  if (execFileSync(node, ['-p', 'typeof process.execve'], { encoding: 'utf8', timeout: 10000 }).trim() !== 'function') {
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
  const files = [
    { path: configFile, content: JSON.stringify(config, null, 2) + '\n' },
    { path: configCore, content: patch.content },
    { path: cli, content: JSON.stringify(preferences, null, indent).replaceAll('\n', newline) + newline },
    { path: unitFile, content: serviceUnit({ node, prefix, configFile, home, env: bootEnv }) },
  ].map(file => ({ ...file, before: readExisting(file.path).digest }));
  return {
    version: 1, home, configHome, packageRoot, prefix, files, source: packageFiles(packageRoot),
    options: {
      home, configHome, stateHome, dataHome, packageRoot, prefix, node, hc, session, intervalMs, shell,
      env: { ...bootEnv, CLAUDE_CONFIG_DIR: config.claudeConfigDir,
        ...(config.socket ? { HC_SOCKET: config.socket } : {}) },
    },
    originalShell: patch.original, configFile, unitFile,
    commands: [['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'herdr-resurrect.service']],
  };
}

function applyInstall(plan, { activate = false } = {}) {
  if (plan.version !== 1 || fs.existsSync(plan.prefix)) throw new Error('Installation destination is not empty or plan is invalid.');
  if (!plan.options || plan.packageRoot !== path.resolve(__dirname, '..')
    || plan.options.node !== executable('node') || plan.options.hc !== executable('hc')) {
    throw new Error('The installation plan does not match this package and local executables.');
  }
  if (!isDeepStrictEqual(planInstall(plan.options), plan)) {
    throw new Error('The installation plan changed or its configuration is stale; generate a new plan.');
  }
  if (activate) {
    const actualConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    if (plan.home !== os.homedir() || plan.configHome !== actualConfigHome
      || process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR !== `/run/user/${process.getuid()}`) {
      throw new Error('Activation requires the actual user home and systemd runtime, not a staging environment.');
    }
    execFileSync('systemctl', ['--user', 'is-active', 'default.target'], { stdio: 'pipe', timeout: 10000 });
    const linger = execFileSync('loginctl', ['show-user', String(process.getuid()), '-p', 'Linger'], {
      encoding: 'utf8', timeout: 10000,
    }).trim();
    if (linger !== 'Linger=yes') throw new Error('User lingering must be enabled before activation.');
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
  if (activate) for (const [command, ...args] of plan.commands) {
    execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  }
  return { installed: true, activated: activate, prefix: plan.prefix, configFile: plan.configFile };
}

// Reverses applyInstall. Every file must still hold exactly what was installed,
// so a later manual edit is never overwritten; nothing changes if one differs.
function uninstall(prefix, { deactivate = true, run = execFileSync } = {}) {
  const record = path.join(prefix, '.installation');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(record, 'manifest.json'), 'utf8')); } catch {
    throw new Error('No installation manifest found; nothing was changed.');
  }
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
  if (deactivate) run('systemctl', ['--user', 'daemon-reload'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  fs.rmSync(prefix, { recursive: true, force: true });
  return { uninstalled: true, restored: steps.map(step => step.path) };
}

module.exports = { planInstall, applyInstall, uninstall, shellPatch, serviceUnit, packageFiles };
