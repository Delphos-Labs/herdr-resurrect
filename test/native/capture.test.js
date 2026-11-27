'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { captureLocal, paneAgents } = require('../../native/capture');
const { layout } = require('./fixtures');

test('parent agents do not inherit their subagents as competing identities', () => {
  const root = { pid: 1, tool: 'bash' };
  const agent = { pid: 2, tool: 'opencode' };
  const worker = { pid: 3, tool: 'claude' };
  const inventory = {
    byPid: new Map([[1, root], [2, agent], [3, worker]]),
    children: new Map([[1, [agent]], [2, [worker]]]),
  };
  assert.deepEqual(paneAgents(1, inventory), [agent]);
});

test('cycles cannot hang process discovery, and parallel roots stay ambiguous', () => {
  const root = { pid: 1, tool: 'bash' };
  const a = { pid: 2, tool: 'opencode' };
  const b = { pid: 3, tool: 'claude' };
  const inventory = {
    byPid: new Map([[1, root], [2, a], [3, b]]),
    children: new Map([[1, [root, a, b]]]),
  };
  assert.deepEqual(paneAgents(1, inventory), [a, b]);
});

test('a changing core document cannot become an apparently consistent snapshot', async () => {
  let version = 0;
  const core = {
    async request(method) {
      if (method === 'doc.get') return { version: ++version, value: layout(['t1']) };
      if (method === 'server.status') return { core: { id: 'core' }, version: '0.1.21' };
      if (method === 'terminal.list') return { terminals: [] };
      throw new Error('unexpected method');
    },
  };
  await assert.rejects(captureLocal(core, {
    host: 'h', boot: 'b', inventory: async () => ({ byPid: new Map(), children: new Map() }),
  }), /Layout changed during capture/);
});

test('100 panes share one process inventory; unavailable terminals stay explicit', async () => {
  const terminals = Array.from({ length: 100 }, (_, i) => `t${i}`);
  let inventories = 0;
  const core = {
    async request(method) {
      if (method === 'doc.get') return { version: 1, value: layout(terminals) };
      if (method === 'server.status') return { core: { id: 'core' }, version: '0.1.21' };
      if (method === 'terminal.list') return { terminals: [] };
      throw new Error('unexpected method');
    },
  };
  const snapshot = await captureLocal(core, {
    host: 'h', boot: 'b',
    inventory: async () => {
      inventories++;
      return { byPid: new Map(), children: new Map() };
    },
  });
  assert.equal(inventories, 1);
  assert.equal(snapshot.programs.length, 100);
  assert.ok(snapshot.programs.every(p => p.state === 'unresolved' && p.reason === 'Terminal is not live.'));
});

test('capture records whether the Claude process set its profile variable', async t => {
  const { spawn } = require('node:child_process');
  const { claudeProfile } = require('../../native/capture');
  const start = env => {
    const child = spawn('sleep', ['30'], { env, stdio: 'ignore' });
    t.after(() => child.kill());
    return child.pid;
  };
  const { CLAUDE_CONFIG_DIR: _unset, ...plain } = process.env;
  assert.deepEqual(claudeProfile(start(plain), '/home/u/.claude'),
    { directory: '/home/u/.claude', explicit: false });
  assert.deepEqual(claudeProfile(start({ ...plain, CLAUDE_CONFIG_DIR: '/home/u/.claude' }), '/fallback'),
    { directory: '/home/u/.claude', explicit: true });
});
