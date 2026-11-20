'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isolatedCore, duringFileEvent } = require('./helpers');
const { layout } = require('../native/fixtures');
const { captureLocal } = require('../../native/capture');
const { remapLayout } = require('../../native/layout');
const { SnapshotStore } = require('../../native/store');

test('isolated core captures distinct live agents and preserves a weighted tree across connections',
  { timeout: 30000 }, async t => {
    const core = isolatedCore(t);
    const records = path.join(core.root, 'records');
    const claude = path.join(core.root, 'claude');
    fs.mkdirSync(records);
    fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
    const started = [];
    const tools = [
      ['opencode', 'ses_first'], ['opencode', 'ses_second'],
      ['claude', '12345678-1234-1234-1234-123456789abc'],
    ];
    for (const [index, [tool, session]] of tools.entries()) {
      const ready = path.join(core.root, `ready-${index}`);
      const result = await duringFileEvent(ready, () => core.client.request('terminal.run', {
        argv: [process.execPath, path.resolve(__dirname, '../fixtures/agent.js'),
          '--prompt', 'THIS MUST NEVER BE SAVED'],
        cwd: core.root, no_parent: true, no_notify: true, outlive_parent: true,
        env: { TEST_TOOL: tool, TEST_SESSION: session, TEST_RECORDS: tool === 'claude' ? claude : records,
          TEST_READY: ready },
      }));
      started.push(result.address);
    }
    const document = layout(started.slice(0, 2));
    document.spaces[0].tabs[0].root.children[1] = {
      id: 'nested', type: 'column', size: { weight: 3 }, children: [
        { id: 'p-second', type: 'block', size: { weight: 2 }, content: { terminal: started[1] } },
        { id: 'p-third', type: 'block', size: { weight: 1 }, content: { terminal: started[2] } },
      ],
    };
    await core.client.request('doc.set', { name: 'herdr-app', version: 0, value: document });
    const snapshot = await captureLocal(core.client, {
      host: 'test-host', boot: 'test-boot', opencodeStateDir: records, claudeConfigDir: claude,
    });
    assert.equal(snapshot.core.id, core.coreId);
    assert.deepEqual(snapshot.programs.map(p => p.session), tools.map(([, session]) => session));
    assert.ok(snapshot.programs.every(p => p.state === 'exact'));
    assert.ok(!JSON.stringify(snapshot).includes('THIS MUST NEVER BE SAVED'));

    const store = new SnapshotStore(path.join(core.root, 'persistent'));
    store.save(snapshot);
    core.client.close();
    fs.rmSync(records, { recursive: true });
    fs.rmSync(claude, { recursive: true });
    assert.deepEqual(store.load().programs.map(p => p.session), tools.map(([, session]) => session));

    const fresh = new (require('../../native/core').CoreClient)({ binary: core.hc, env: core.env });
    t.after(() => fresh.close());
    const saved = await fresh.request('doc.get', { name: 'herdr-app' });
    assert.deepEqual(saved.value, document);
    const remapped = remapLayout(saved.value, Object.fromEntries(started.map((id, i) => [id, `restored-${i}`])));
    await fresh.request('doc.set', { name: 'herdr-app', version: saved.version, value: remapped });
    const roundTrip = await fresh.request('doc.get', { name: 'herdr-app' });
    assert.deepEqual(roundTrip.value, remapped);
    assert.equal(roundTrip.value.spaces[0].tabs[0].root.children[1].size.weight, 3);
    await assert.rejects(fresh.request('doc.set', {
      name: 'herdr-app', version: saved.version, value: document,
    }), error => error.kind === 'conflict');
  });
