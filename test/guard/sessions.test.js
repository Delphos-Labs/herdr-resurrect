'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { isolatedCore } = require('../integration/helpers');
const { snapshot, layout } = require('../native/fixtures');
const { verifySession } = require('../../native/sessions');
const { restore } = require('../../native/restore');

const execute = promisify(execFile);

async function api(method, route, body) {
  const args = ['api', method, route];
  if (body) args.push('--data', JSON.stringify(body));
  const result = await execute('opencode', args, {
    cwd: path.resolve(__dirname, '../..'), timeout: 15000, maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

test('a deleted real OpenCode session is refused without launching or recreating a chat',
  { timeout: 30000 }, async t => {
    const core = isolatedCore(t);
    const created = await api('post', '/api/session', {
      title: `Herdr missing-session guard: ${randomUUID()}`,
      location: { directory: path.resolve(__dirname, '../..') },
    });
    const info = created.data || created;
    let deleted = false;
    t.after(async () => {
      if (!deleted) await api('delete', `/api/session/${info.id}`);
    });
    const program = {
      terminal: 'lost-terminal', state: 'exact', tool: 'opencode', session: info.id, cwd: core.root,
    };
    assert.deepEqual(await verifySession(program), { id: info.id, created: info.time.created });
    await api('delete', `/api/session/${info.id}`);
    deleted = true;
    const saved = snapshot({ layout: layout(['lost-terminal']), programs: [program] });
    const stateDir = path.join(core.root, 'snapshots');
    fs.mkdirSync(stateDir);
    await assert.rejects(restore(core.client, saved, { stateDir, host: saved.host }), /Cannot confirm/);
    assert.equal((await core.client.request('terminal.list')).terminals.length, 0);
    assert.equal((await core.client.request('doc.get', { name: 'herdr-app' })).value, null);
    await assert.rejects(api('get', `/api/session/${info.id}`));
  });
