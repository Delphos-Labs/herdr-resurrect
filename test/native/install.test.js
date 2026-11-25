'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planInstall, applyInstall, uninstall, shellPatch, serviceUnit } = require('../../native/install');
const { readConfig } = require('../../native/config');

function home(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-install-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('core shell edits preserve unrelated values and comments and reject a second recovery engine', () => {
  const before = '# keep this comment\nshell = ["fish"] # personal shell\nnotes = false\n[other]\na = "value"\n';
  const result = shellPatch(before, ['/node', '/hook', '--config', '/config'], ['/bin/sh']);
  assert.deepEqual(result.original, ['fish']);
  assert.ok(result.content.includes('# keep this comment'));
  assert.ok(result.content.includes('# personal shell'));
  assert.ok(result.content.includes('notes = false\n[other]\na = "value"'));
  assert.throws(() => shellPatch('shell = [\n "fish"\n]\n', ['/hook'], ['/bin/sh']), /single-line/);
  assert.throws(() => shellPatch('shell = ["herdr-wake","shell"]\n', ['/hook'], ['/bin/sh']), /Do not nest/);
});

test('installation planning changes no files and staged application preserves CLI preferences', t => {
  const directory = home(t);
  const configHome = path.join(directory, '.config');
  fs.mkdirSync(path.join(configHome, 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(configHome, 'herdr-core'), { recursive: true });
  fs.writeFileSync(path.join(configHome, 'opencode/cli.json'), '{"plugins":["existing"],"theme":"keep"}\n');
  fs.writeFileSync(path.join(configHome, 'herdr-core/config.toml'), '# keep\nshell = ["fish"]\nnotes = false\n');
  const options = {
    home: directory, configHome, stateHome: path.join(directory, 'state'),
    dataHome: path.join(directory, 'data'), shell: ['/bin/sh'],
  };
  const plan = planInstall(options);
  assert.equal(fs.existsSync(plan.prefix), false);
  assert.equal(fs.readFileSync(path.join(configHome, 'opencode/cli.json'), 'utf8'),
    '{"plugins":["existing"],"theme":"keep"}\n');
  const installed = applyInstall(plan);
  assert.equal(installed.activated, false);
  const cli = JSON.parse(fs.readFileSync(path.join(configHome, 'opencode/cli.json')));
  assert.deepEqual(cli.plugins, ['existing', path.join(plan.prefix, 'integrations/opencode')]);
  assert.equal(cli.theme, 'keep');
  assert.ok(fs.readFileSync(path.join(configHome, 'herdr-core/config.toml'), 'utf8').includes('notes = false'));
  const config = readConfig(plan.configFile);
  assert.equal(config.intervalMs, 60000);
  assert.equal(config.stateDir, path.join(directory, 'state/herdr-resurrect/snapshots'));
  assert.ok(fs.existsSync(path.join(plan.prefix, 'node_modules/proper-lockfile/index.js')));
  const result = execFileSync('systemd-analyze', ['--user', 'verify', plan.unitFile], { encoding: 'utf8' });
  assert.equal(result.trim(), '');
  assert.throws(() => applyInstall(plan), /destination is not empty/);
});

test('changed configuration and edited installation plans cannot be applied', t => {
  const directory = home(t);
  const options = {
    home: directory, configHome: path.join(directory, 'config'),
    stateHome: path.join(directory, 'state'), dataHome: path.join(directory, 'data'),
  };
  const plan = planInstall(options);
  const changed = structuredClone(plan);
  changed.commands = [['/bin/sh', '-c', 'unapproved command']];
  assert.throws(() => applyInstall(changed), /plan changed/);
  fs.mkdirSync(path.dirname(plan.configFile), { recursive: true });
  fs.writeFileSync(plan.configFile, '{"user":"changed"}');
  assert.throws(() => applyInstall(plan), /plan changed|configuration is stale/);
  assert.equal(fs.existsSync(plan.prefix), false);
});

function installedHome(t) {
  const directory = home(t);
  const configHome = path.join(directory, '.config');
  fs.mkdirSync(path.join(configHome, 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(configHome, 'herdr-core'), { recursive: true });
  const cli = '{"plugins":["existing"]}\n';
  const core = '# keep\nshell = ["fish"]\n';
  fs.writeFileSync(path.join(configHome, 'opencode/cli.json'), cli);
  fs.writeFileSync(path.join(configHome, 'herdr-core/config.toml'), core);
  const plan = planInstall({ home: directory, configHome, stateHome: path.join(directory, 'state'),
    dataHome: path.join(directory, 'data'), shell: ['/bin/sh'] });
  applyInstall(plan);
  return { plan, configHome, cli, core };
}

test('the core shell starts the gateway through /bin/sh so a missing Node still opens the shell', t => {
  const { plan, configHome } = installedHome(t);
  const text = fs.readFileSync(path.join(configHome, 'herdr-core/config.toml'), 'utf8');
  const shell = JSON.parse(text.match(/^shell = (.*)$/m)[1]);
  assert.deepEqual(shell.slice(0, 2), ['/bin/sh', path.join(plan.prefix, 'bin/native-shell.sh')]);
  assert.deepEqual(shell.slice(-2), ['--', 'fish']);
  assert.ok(fs.existsSync(path.join(plan.prefix, 'bin/native-shell.sh')));
});

test('uninstall restores every file exactly and removes the installation', t => {
  const { plan, configHome, cli, core } = installedHome(t);
  const calls = [];
  const result = uninstall(plan.prefix, { run: (...args) => calls.push(args) });
  assert.equal(result.uninstalled, true);
  assert.equal(fs.readFileSync(path.join(configHome, 'opencode/cli.json'), 'utf8'), cli);
  assert.equal(fs.readFileSync(path.join(configHome, 'herdr-core/config.toml'), 'utf8'), core);
  assert.equal(fs.existsSync(plan.configFile), false);
  assert.equal(fs.existsSync(plan.unitFile), false);
  assert.equal(fs.existsSync(plan.prefix), false);
  assert.deepEqual(calls.map(([command, args]) => [command, ...args]), [
    ['systemctl', '--user', 'disable', '--now', 'herdr-resurrect.service'],
    ['systemctl', '--user', 'daemon-reload'],
  ]);
});

test('uninstall changes nothing when an installed file was edited afterwards', t => {
  const { plan, configHome } = installedHome(t);
  const core = path.join(configHome, 'herdr-core/config.toml');
  fs.appendFileSync(core, 'notes = true\n');
  const edited = fs.readFileSync(core, 'utf8');
  const calls = [];
  assert.throws(() => uninstall(plan.prefix, { run: (...args) => calls.push(args) }), /changed after installation/);
  assert.equal(fs.readFileSync(core, 'utf8'), edited);
  assert.ok(fs.existsSync(plan.prefix));
  assert.deepEqual(calls, []);
});

test('service commands escape systemd expansion and do not save credentials', () => {
  const unit = serviceUnit({
    node: '/node', prefix: '/home/u/a%hb/$name', configFile: '/config', home: '/home/u',
    env: { PATH: '/usr/bin', LANG: 'en_US.UTF-8' },
  });
  assert.ok(unit.includes('a%%hb/$$name'));
  assert.ok(unit.includes('Restart=on-failure'));
  assert.ok(unit.includes('KillMode=control-group'));
  assert.ok(!unit.includes('ANTHROPIC') && !unit.includes('TOKEN'));
});
