'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshot, layout } = require('./fixtures');
const { planRestore, restore, mergeLayout } = require('../../native/restore');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-restore-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = snapshot();
  saved.programs.forEach(program => { program.cwd = directory; });
  const terminals = [];
  const calls = [];
  let doc = { version: 1, value: saved.layout };
  let conflict = false;
  const core = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'hello') return { version: '0.1.21' };
      if (method === 'doc.get') return structuredClone(doc);
      if (method === 'terminal.list') return { terminals: structuredClone(terminals) };
      if (method === 'terminal.run') {
        const terminal = { address: `new-${terminals.length}`, state: 'live', labels: { ...params.labels } };
        terminals.push(terminal);
        return structuredClone(terminal);
      }
      if (method === 'terminal.get') return structuredClone(terminals.find(item => item.address === params.terminal));
      if (method === 'terminal.kill') {
        terminals.find(item => item.address === params.terminal).state = 'finished';
        return {};
      }
      if (method === 'terminal.label') {
        Object.assign(terminals.find(item => item.address === params.terminal).labels, params.labels);
        return {};
      }
      if (method === 'doc.set') {
        if (conflict) throw new Error('version conflict');
        doc = { version: doc.version + 1, value: params.value };
        return { version: doc.version };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
  return { directory, saved, terminals, calls, core, conflict: () => { conflict = true; } };
}

function options(env) {
  return { stateDir: env.directory, host: 'host-a',
    verifySession: async program => ({ id: program.session }) };
}

test('preview launches nothing and canonical commands contain only exact session IDs', async t => {
  const env = setup(t);
  const plan = await planRestore(env.core, env.saved, options(env));
  assert.deepEqual(plan.actions.map(action => action.argv), [
    ['opencode', '-s', 'ses_one'],
    ['claude', '--resume', '12345678-1234-1234-1234-123456789abc'],
  ]);
  assert.ok(!env.calls.some(call => call.method === 'terminal.run' || call.method === 'doc.set'));
});

test('second restore preserves live terminals and starts no duplicates', async t => {
  const env = setup(t);
  const config = options(env);
  const first = await restore(env.core, env.saved, config);
  assert.equal(first.started, 2);
  assert.equal(first.verified, false);
  const second = await restore(env.core, env.saved, config);
  assert.equal(second.started, 0);
  assert.ok(second.actions.every(action => action.action === 'keep-live'));
  assert.equal(env.terminals.filter(terminal => terminal.state === 'live').length, 2);
});

test('busy live terminals are kept without typing, killing or replacing them', async t => {
  const env = setup(t);
  env.terminals.push({ address: 't1', state: 'live', labels: {} });
  const result = await restore(env.core, env.saved, options(env));
  assert.equal(result.started, 1);
  assert.ok(!env.calls.some(call => call.method === 'terminal.kill' && call.params.terminal === 't1'));
  assert.ok(!env.calls.some(call => call.method === 'terminal.send' || call.method === 'terminal.keys'));
});

test('a layout conflict cleans up only terminals created by this restore', async t => {
  const env = setup(t);
  env.terminals.push({ address: 'unrelated', state: 'live', labels: {} });
  env.conflict();
  await assert.rejects(restore(env.core, env.saved, options(env)), /version conflict/);
  assert.equal(env.terminals[0].state, 'live');
  assert.ok(env.terminals.slice(1).every(terminal => terminal.state === 'finished'));
});

test('unknown identities and another host cannot trigger partial execution', async t => {
  const env = setup(t);
  await assert.rejects(planRestore(env.core, env.saved, { ...options(env), host: 'other' }), /another host/);
  env.saved.programs[1].state = 'unresolved';
  await assert.rejects(restore(env.core, env.saved, options(env)), /no exact/);
  assert.ok(!env.calls.some(call => call.method === 'terminal.run'));
});

test('an interrupted restore can attach its live orphan processes without relaunching', async t => {
  const env = setup(t);
  env.terminals.push(
    { address: 'orphan-a', state: 'live', labels: { 'resurrect.host': 'host-a', 'resurrect.pane': 'pane-0' } },
    { address: 'orphan-b', state: 'live', labels: { 'resurrect.host': 'host-a', 'resurrect.pane': 'pane-1' } },
  );
  const result = await restore(env.core, env.saved, options(env));
  assert.equal(result.started, 0);
  const committed = env.calls.find(call => call.method === 'doc.set');
  assert.deepEqual(committed.params.value.spaces[0].tabs[0].root.children.map(node => node.content.terminal),
    ['orphan-a', 'orphan-b']);
  assert.ok(env.terminals.every(terminal => terminal.labels['herdr.tab'] === 'tb-agents'));
});

test('session disappearance or replacement blocks launch after preview', async t => {
  const env = setup(t);
  let calls = 0;
  await assert.rejects(restore(env.core, env.saved, {
    ...options(env),
    verifySession: async program => {
      calls++;
      return { id: program.session, created: calls > 2 ? 200 : 100 };
    },
  }), /session changed/);
  assert.ok(!env.calls.some(call => call.method === 'terminal.run'));
});

test('merge preserves unrelated spaces and refuses changed geometry', () => {
  const saved = layout(['t1']);
  const current = structuredClone(saved);
  current.spaces.push({ id: 'unrelated-space', name: 'Keep', folder: '/', tabs: [] });
  const merged = mergeLayout(saved, current, { t1: 'new' });
  assert.equal(merged.spaces[1].name, 'Keep');
  current.spaces[0].tabs[0].root.children[0].size.weight = 99;
  assert.throws(() => mergeLayout(saved, current, { t1: 'new' }), /Layout changed/);
});

test('a default-profile Claude session is launched without a Claude profile variable', async t => {
  const env = setup(t);
  const claude = env.saved.programs.find(program => program.tool === 'claude');
  Object.assign(claude, { profile: path.join(os.homedir(), '.claude'), profileExplicit: false });
  await restore(env.core, env.saved, { ...options(env), env: { CLAUDE_CONFIG_DIR: '/caller/profile' }, shell: '/usr/bin/fish' });
  const run = env.calls.find(call => call.method === 'terminal.run' && call.params.argv.includes('--resume'));
  assert.deepEqual(run.params.argv.slice(0, 5), ['/usr/bin/fish', '-l', '-c', 'exec $argv', '--']);
  assert.deepEqual(run.params.argv.slice(5, 9).map(value => path.basename(value)), ['env', '-u', 'CLAUDE_CONFIG_DIR', 'claude']);
  assert.ok(!Object.hasOwn(run.params.env, 'CLAUDE_CONFIG_DIR'));
});

test('a missing saved directory falls back to the directory the session record names', async t => {
  const env = setup(t);
  const start = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-start-'));
  t.after(() => fs.rmSync(start, { recursive: true, force: true }));
  env.saved.programs.forEach(program => { program.cwd = path.join(env.directory, 'deleted'); });
  const plan = await planRestore(env.core, env.saved, { ...options(env),
    verifySession: async program => ({ id: program.session,
      ...(program.tool === 'claude' ? { startCwd: start } : { directory: start }) }) });
  assert.deepEqual(plan.actions.map(action => [action.cwd, action.savedCwd]),
    [[start, path.join(env.directory, 'deleted')], [start, path.join(env.directory, 'deleted')]]);
});

test('an existing saved directory wins over the session start directory', async t => {
  const env = setup(t);
  const plan = await planRestore(env.core, env.saved, { ...options(env),
    verifySession: async program => ({ id: program.session, startCwd: os.tmpdir(), directory: os.tmpdir() }) });
  assert.ok(plan.actions.every(action => action.cwd === env.directory && !('savedCwd' in action)));
});

test('a pane with no existing directory is refused before anything starts', async t => {
  const env = setup(t);
  env.saved.programs[1].cwd = '/no/such/dir';
  await assert.rejects(restore(env.core, env.saved, options(env)), /No saved working directory exists/);
  assert.ok(!env.calls.some(call => call.method === 'terminal.run'));
});
