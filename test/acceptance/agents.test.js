'use strict';

// Explicit opt-in via npm run test:real. Uses signed-in agent CLIs and real model requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { CoreClient } = require('../../native/core');
const { SnapshotStore } = require('../../native/store');
const { restore } = require('../../native/restore');
const { isolatedCore, duringFileEvent } = require('../integration/helpers');
const { observeOutput } = require('../integration/observe');

const execute = promisify(execFile);

async function api(method, route, body) {
  const args = ['api', method, route];
  if (body !== undefined) args.push('--data', JSON.stringify(body));
  const result = await execute('opencode', args, {
    timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    cwd: path.resolve(__dirname, '../..'),
  });
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

function claudeRows(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch {
      if (line === text.split('\n').at(-1)) return [];
      throw new Error('Malformed Claude test transcript.');
    }
  });
}

function assistantCount(rows, marker) {
  return rows.filter(row => row.type === 'assistant'
    && JSON.stringify(row.message || row).includes(marker)).length;
}

test('real Claude and two same-directory OpenCode conversations survive isolated core loss',
  { timeout: 360000 }, async t => {
    const core = isolatedCore(t);
    core.client.timeoutMs = 45000;
    const run = randomUUID();
    const artifacts = path.resolve(__dirname, '../../.local/acceptance', run);
    const cwd = path.join(artifacts, 'work');
    const state = path.join(artifacts, 'snapshots');
    const records = path.join(artifacts, 'agents');
    const claudeRoot = process.env.HERDR_TEST_CLAUDE_CONFIG_DIR
      || path.resolve(__dirname, '../../.local/claude-auth');
    for (const directory of [cwd, state, records, claudeRoot]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    assert.equal(process.env.HERDR_ACCEPT_WORKSPACE_TRUST, '1',
      'Approve only the generated test folder through HERDR_ACCEPT_WORKSPACE_TRUST=1.');
    assert.ok(cwd.startsWith(path.resolve(__dirname, '../../.local/acceptance') + path.sep));
    assert.ok(path.resolve(claudeRoot).startsWith(path.resolve(__dirname, '../../.local') + path.sep),
      'The acceptance test must use a private test profile, not the normal Claude profile.');
    const authEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeRoot };
    delete authEnv.ANTHROPIC_API_KEY;
    const auth = JSON.parse((await execute('claude', ['auth', 'status', '--json'], {
      env: authEnv, timeout: 10000,
    })).stdout);
    assert.equal(auth.loggedIn, true, 'Sign in to the private Claude test profile before running paid acceptance.');
    assert.notEqual(auth.authMethod, 'api_key', 'The rejected environment API key must not be used.');
    const profileFile = path.join(claudeRoot, '.claude.json');
    const profile = fs.existsSync(profileFile) ? JSON.parse(fs.readFileSync(profileFile, 'utf8')) : {};
    profile.hasCompletedOnboarding = true;
    profile.theme ||= 'dark';
    profile.projects ||= {};
    profile.projects[cwd] = { ...profile.projects[cwd], hasTrustDialogAccepted: true };
    fs.writeFileSync(profileFile, JSON.stringify(profile), { mode: 0o600 });
    const receipt = { run, status: 'running', artifacts, sessions: [], stages: [] };
    const writeReceipt = () => fs.writeFileSync(path.join(artifacts, 'receipt.json'),
      JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    writeReceipt();
    console.log(`Real acceptance artifacts: ${artifacts}`);

    const realEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
      XDG_STATE_HOME: process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
      HERDR_RESURRECT_AGENT_DIR: records,
      OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({
        plugins: [path.resolve(__dirname, '../../integrations/opencode')],
      }),
      CLAUDE_CODE_SAFE_MODE: '1',
      CLAUDE_CONFIG_DIR: claudeRoot,
      ANTHROPIC_API_KEY: '',
    };
    const store = new SnapshotStore(state);
    let recorder;
    let current = core.client;
    const stopped = path.join(artifacts, 'recorder-stopped');
    core.beforeStop(async () => {
      if (recorder) {
        await duringFileEvent(stopped, async () => {
          try { process.kill(recorder, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        });
      }
      current?.close();
    });
    try {
      for (const label of ['A', 'B']) {
        const marker = `HERDR_${label}_${randomUUID().replaceAll('-', '')}`;
        const created = await api('post', '/api/session', {
          title: `Herdr recovery acceptance ${label}: ${run}`, location: { directory: cwd },
          permissions: [{ action: '*', resource: '*', effect: 'deny' }],
        });
        const session = created.data || created;
        const prompt = `Remember this verification code: ${marker}. Reply with that code only. Do not use tools.`;
        await api('post', `/api/session/${session.id}/prompt`, { text: prompt });
        await api('post', `/api/experimental/session/${session.id}/wait`);
        const history = await api('get', `/api/session/${session.id}/message?limit=100`);
        assert.ok(assistantCount(history.data, marker) > 0, `OpenCode ${label} did not produce its marker.`);
        const terminal = await current.request('terminal.run', {
          argv: ['opencode', '-s', session.id], cwd, env: realEnv,
          no_parent: true, no_notify: true, outlive_parent: true,
        });
        receipt.sessions.push({ tool: 'opencode', session: session.id, marker, prompt, terminal: terminal.address });
        writeReceipt();
      }
      const claudeSession = randomUUID();
      const marker = `HERDR_C_${randomUUID().replaceAll('-', '')}`;
      const prompt = `Remember this verification code: ${marker}. Reply with that code only. Do not use tools.`;
      const project = path.join(claudeRoot, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(project, { recursive: true });
      const transcript = path.join(project, `${claudeSession}.jsonl`);
      const claude = await duringFileEvent(transcript, async () => {
        const terminal = await current.request('terminal.run', {
          argv: ['claude', '--safe-mode', '--permission-mode', 'plan', '--tools', '',
            '--session-id', claudeSession, prompt],
          cwd, env: realEnv, no_parent: true, no_notify: true, outlive_parent: true,
        });
        return terminal;
      }, () => assistantCount(claudeRows(transcript), marker) > 0, 120000);
      receipt.sessions.push({ tool: 'claude', session: claudeSession, marker, prompt,
        terminal: claude.address, transcript });
      receipt.stages.push('real conversations created');
      writeReceipt();

      const document = {
        spaces: [{ id: 'sp-acceptance', name: 'Real acceptance', folder: cwd, tabs: [
          { id: 'tb-acceptance', name: 'Three conversations', root: {
            id: 'root', type: 'row', children: receipt.sessions.map((session, i) => ({
              id: `pane-${i}`, type: 'block', size: { weight: i + 1 }, content: { terminal: session.terminal },
            })),
          } },
        ] }],
      };
      await current.request('doc.set', { name: 'herdr-app', version: 0, value: document });
      const last = path.join(state, 'last.json');
      await duringFileEvent(last, async () => {
        const launch = execFileSync(process.execPath, [
          path.resolve(__dirname, '../fixtures/launcher.js'),
          path.resolve(__dirname, '../fixtures/recorder-worker.js'),
          path.join(artifacts, 'recorder.log'),
          '--state-dir', state, '--opencode-state-dir', records, '--interval-ms', '1000', '--hc', core.hc,
          '--claude-config-dir', claudeRoot,
        ], { env: { ...core.env, TEST_STOPPED: stopped }, encoding: 'utf8', timeout: 10000 });
        recorder = JSON.parse(launch).pid;
      }, () => store.load()?.programs.length === 3
        && store.load().programs.every(program => program.state === 'exact'), 60000);
      const beforeDisconnect = store.load().at;
      current.close();
      current = null;
      await duringFileEvent(last, async () => {},
        () => store.load().at > beforeDisconnect, 10000);
      const saved = store.load();
      assert.deepEqual(saved.programs.map(program => program.session),
        receipt.sessions.map(session => session.session));
      receipt.stages.push('automatic snapshot advanced without client');
      writeReceipt();

      core.command(['server', 'stop']);
      core.command(['server', 'start']);
      current = new CoreClient({ binary: core.hc, env: core.env, timeoutMs: 120000 });
      const restored = await restore(current, saved, { stateDir: state, host: saved.host, env: realEnv });
      assert.equal(restored.started, 3);
      assert.deepEqual(restored.labels, []);
      const mapping = new Map(restored.actions.map(action => [action.source, action.terminal]));
      await duringFileEvent(last, async () => {}, () => {
        const latest = store.load();
        return latest.programs.length === 3
          && latest.programs.every(program => program.state === 'exact' && !program.observed)
          && latest.programs.every(program => !receipt.sessions.some(session => session.terminal === program.terminal));
      }, 60000);
      const observed = store.load();
      assert.deepEqual(observed.programs.map(program => [program.tool, program.session]),
        receipt.sessions.map(session => [session.tool, session.session]));
      assert.ok(observed.programs.every(program => program.cwd === cwd));
      receipt.observedAfterRestore = observed.programs.map(program => ({
        terminal: program.terminal, tool: program.tool, session: program.session, cwd: program.cwd,
      }));
      receipt.stages.push('new real processes report the original conversation IDs');
      writeReceipt();

      const question = 'What verification code did I give you earlier? Reply with the code only. Do not use tools.';
      for (const session of receipt.sessions) {
        if (session.tool === 'opencode') {
          await api('post', `/api/session/${session.session}/prompt`, { text: question });
          await api('post', `/api/experimental/session/${session.session}/wait`);
          const history = await api('get', `/api/session/${session.session}/message?limit=100`);
          assert.ok(assistantCount(history.data, session.marker) >= 2, 'OpenCode lost conversation content.');
          assert.equal(history.data.filter(row => row.type === 'user'
            && JSON.stringify(row).includes(session.prompt)).length, 1, 'OpenCode replayed the original prompt.');
        } else {
          await duringFileEvent(session.transcript, () => current.request('terminal.send', {
            terminal: mapping.get(session.terminal), text: question,
          }), () => assistantCount(claudeRows(session.transcript), session.marker) >= 2, 120000);
          assert.equal(claudeRows(session.transcript).filter(row => row.type === 'user'
            && JSON.stringify(row.message).includes(session.prompt)).length, 1, 'Claude replayed the original prompt.');
        }
        await observeOutput(core.hc, core.env, mapping.get(session.terminal),
          text => text.includes(session.marker));
        const screen = await current.request('terminal.read', { terminal: mapping.get(session.terminal), lines: 0 });
        assert.ok(JSON.stringify(screen).includes(session.marker), `${session.tool} did not display its recovered content.`);
      }
      const again = await restore(current, saved, { stateDir: state, host: saved.host, env: realEnv });
      assert.equal(again.started, 0);
      const terminals = await current.request('terminal.list');
      assert.equal(terminals.terminals.filter(terminal => terminal.state === 'live').length, 3);
      receipt.stages.push('all agents recalled original codes; no prompt replay; repeated restore started zero processes');
      receipt.status = 'passed';
      writeReceipt();
    } catch (error) {
      receipt.status = 'failed';
      receipt.error = error.message;
      if (current) {
        try {
          const listed = await current.request('terminal.list');
          for (const terminal of listed.terminals.filter(terminal => terminal.state === 'live')) {
            const screen = await current.request('terminal.read', { terminal: terminal.address, lines: 0 });
            fs.writeFileSync(path.join(artifacts, `${terminal.address}.screen.json`), JSON.stringify(screen),
              { mode: 0o600 });
          }
        } catch (captureError) { receipt.diagnostics = captureError.message; }
      }
      writeReceipt();
      throw error;
    }
  });
