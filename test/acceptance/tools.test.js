'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { CoreClient } = require('../../native/core');
const { captureLocal } = require('../../native/capture');
const { restore } = require('../../native/restore');
const { SnapshotStore } = require('../../native/store');
const { isolatedCore, duringFileEvent } = require('../integration/helpers');
const { observeOutput } = require('../integration/observe');

test('real tuicr annotations, btop and gh-dash survive isolated core loss',
  { timeout: 90000 }, async t => {
    const btop = process.env.HERDR_TEST_BTOP
      || path.resolve(__dirname, '../../.local/acceptance-tools/btop/usr/bin/btop');
    assert.ok(fs.existsSync(btop), 'Set HERDR_TEST_BTOP to an installed btop binary.');
    const core = isolatedCore(t);
    core.client.timeoutMs = 45000;
    const run = randomUUID();
    const artifacts = path.resolve(__dirname, '../../.local/acceptance', run);
    fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    const file = path.join(artifacts, 'review.md');
    const config = path.join(artifacts, 'dashboard.yml');
    fs.writeFileSync(file, '# Recovery acceptance\n\nReview this saved document.\n');
    fs.writeFileSync(config, 'prSections:\n  - title: Recovery acceptance\n'
      + '    filters: repo:Delphos-Labs/herdr-resurrect is:open is:pr\nissuesSections: []\n');
    const receipt = { run, status: 'running', artifacts, stages: [] };
    const writeReceipt = () => fs.writeFileSync(path.join(artifacts, 'receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    writeReceipt();
    console.log(`Real tool acceptance artifacts: ${artifacts}`);
    const env = {
      PATH: path.dirname(btop) + path.delimiter + core.env.PATH,
      XDG_DATA_HOME: core.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: core.env.XDG_CONFIG_HOME,
      XDG_STATE_HOME: core.env.XDG_STATE_HOME,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || path.join(os.homedir(), '.config', 'gh'),
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    };
    const extension = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'),
      'gh', 'extensions', 'gh-dash');
    assert.ok(fs.existsSync(path.join(extension, 'gh-dash')), 'The real gh-dash extension is required.');
    const extensions = path.join(core.env.XDG_DATA_HOME, 'gh', 'extensions');
    fs.mkdirSync(extensions, { recursive: true });
    fs.symlinkSync(extension, path.join(extensions, 'gh-dash'), 'dir');
    const toolEnv = { ...core.env, ...env };
    let current = core.client;
    core.beforeStop(() => current.close());
    const command = args => JSON.parse(execFileSync('tuicr', args, {
      env: toolEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
    }));
    const sessions = path.join(core.env.XDG_DATA_HOME, 'tuicr', 'reviews', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const sessionForFile = () => {
      const rows = command(['review', 'list', '--all']);
      return rows.find(row => {
        const saved = JSON.parse(fs.readFileSync(row.path, 'utf8'));
        return saved.diff_source === 'file' && Object.values(saved.files).some(item =>
          path.resolve(saved.repo_path, item.path) === file);
      });
    };
    try {
      const review = await current.request('terminal.run', {
        argv: ['tuicr', '--no-update-check', '--file', file], cwd: artifacts, env,
        no_parent: true, no_notify: true, outlive_parent: true,
      });
      await observeOutput(core.hc, core.env, review.address, text => text.includes('NORMAL'));
      const persisted = sessionForFile();
      assert.ok(persisted, 'Rendered tuicr review was not found in the isolated review registry.');
      const annotation = `SAVED_ANNOTATION_${randomUUID()}`;
      command(['review', 'add', '--session', persisted.path, '--target-file', 'review.md',
        '--line', '3', '--type', 'note', '--username', 'Recovery acceptance test', annotation]);
      const monitor = await current.request('terminal.run', {
        argv: [btop], cwd: artifacts, env, no_parent: true, no_notify: true, outlive_parent: true,
      });
      const dashboard = await current.request('terminal.run', {
        argv: ['gh', 'dash', '--config', config], cwd: artifacts, env,
        no_parent: true, no_notify: true, outlive_parent: true,
      });
      await observeOutput(core.hc, core.env, dashboard.address,
        text => text.replace(/\s/g, '').includes('Recoveryacceptance'));
      const original = [review.address, monitor.address, dashboard.address];
      const document = { spaces: [{ id: 'sp-tools', name: 'Tool proof', folder: artifacts, tabs: [
        { id: 'tb-tools', name: 'Tools', root: { id: 'root-tools', type: 'row',
          children: original.map((terminal, i) => ({
            id: `tool-pane-${i}`, type: 'block', size: { weight: i + 1 }, content: { terminal },
          })) } },
      ] }] };
      await current.request('doc.set', { name: 'herdr-app', version: 0, value: document });
      const snapshot = await captureLocal(current, {
        host: 'tool-proof-host', boot: 'tool-proof-boot', toolOptions: { env: toolEnv },
      });
      assert.ok(snapshot.programs.every(program => program.state === 'tool'),
        JSON.stringify(snapshot.programs));
      const store = new SnapshotStore(path.join(artifacts, 'snapshots'));
      store.save(snapshot);
      receipt.review = { session: persisted.slug, annotation };
      receipt.stages.push('real tools captured with exact persisted review');
      writeReceipt();
      core.command(['server', 'stop']);
      core.command(['server', 'start']);
      current = new CoreClient({ binary: core.hc, env: core.env, timeoutMs: 45000 });
      const report = await restore(current, store.load(), {
        stateDir: store.directory, host: 'tool-proof-host', env,
      });
      assert.equal(report.started, 3);
      const mapped = new Map(report.actions.map(action => [action.source, action.terminal]));
      await observeOutput(core.hc, core.env, mapped.get(review.address), text => text.includes(annotation));
      await observeOutput(core.hc, core.env, mapped.get(dashboard.address),
        text => text.replace(/\s/g, '').includes('Recoveryacceptance'));
      const reviewScreen = await current.request('terminal.read', {
        terminal: mapped.get(review.address), lines: 0,
      });
      assert.ok(reviewScreen.text.includes(annotation), 'Tuicr did not display its saved annotation.');
      assert.equal(sessionForFile().slug, persisted.slug);
      assert.ok(JSON.stringify(command(['review', 'comments', '--session', persisted.path])).includes(annotation));
      const monitorScreen = await current.request('terminal.read', {
        terminal: mapped.get(monitor.address), lines: 0,
      });
      assert.match(monitorScreen.text, /cpu/i);
      assert.match(monitorScreen.text, /mem/i);
      const dashScreen = await current.request('terminal.read', {
        terminal: mapped.get(dashboard.address), lines: 0,
      });
      assert.ok(dashScreen.text.includes('Recovery acceptance'), 'Dashboard did not load its saved section.');
      const repeated = await restore(current, store.load(), {
        stateDir: store.directory, host: 'tool-proof-host', env,
      });
      assert.equal(repeated.started, 0);
      receipt.stages.push('restored tools render saved review, live metrics and configured dashboard; repeat starts zero');
      receipt.status = 'passed';
      writeReceipt();
    } catch (error) {
      receipt.status = 'failed';
      receipt.error = error.message;
      try {
        const listed = await current.request('terminal.list', { all: true });
        for (const terminal of listed.terminals) {
          const screen = await current.request('terminal.read', { terminal: terminal.address, lines: 0 });
          fs.writeFileSync(path.join(artifacts, `${terminal.address}.screen.json`),
            JSON.stringify(screen), { mode: 0o600 });
        }
      } catch (diagnostic) { receipt.diagnostics = diagnostic.message; }
      writeReceipt();
      throw error;
    }
  });
