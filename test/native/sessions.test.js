'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifySession } = require('../../native/sessions');

test('OpenCode requires the saved ID and creation identity from the real API shape', async () => {
  const calls = [];
  const result = await verifySession({
    state: 'exact', tool: 'opencode', session: 'ses_saved', cwd: '/work',
  }, { run: async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ data: { id: 'ses_saved', time: { created: 1234 } } }) };
  } });
  assert.deepEqual(result, { id: 'ses_saved', created: 1234 });
  assert.deepEqual(calls[0][1], ['api', 'get', '/api/session/ses_saved']);
  assert.equal(calls[0][2].cwd, '/work');
});

test('an unavailable or mismatched OpenCode session is not treated as a fresh chat', async () => {
  const program = { state: 'exact', tool: 'opencode', session: 'ses_saved', cwd: '/work' };
  await assert.rejects(verifySession(program, { run: async () => { throw new Error('private upstream detail'); } }),
    error => /Cannot confirm/.test(error.message) && !error.message.includes('private upstream detail'));
  await assert.rejects(verifySession(program, {
    run: async () => ({ stdout: JSON.stringify({ data: { id: 'ses_other', time: { created: 1 } } }) }),
  }), /different or invalid/);
  await assert.rejects(verifySession({ ...program, sessionCreated: 1 }, {
    run: async () => ({ stdout: JSON.stringify({ data: { id: 'ses_saved', time: { created: 2 } } }) }),
  }), /was replaced/);
});

test('Claude requires an existing nonempty transcript in the selected profile', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-session-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const program = {
    state: 'exact', tool: 'claude', session: '12345678-1234-1234-1234-123456789abc', cwd: '/my/work',
  };
  const config = { env: { CLAUDE_CONFIG_DIR: profile } };
  await assert.rejects(verifySession(program, config), /transcript is missing/);
  const folder = path.join(profile, 'projects', '-my-work');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${program.session}.jsonl`);
  fs.writeFileSync(file, '');
  await assert.rejects(verifySession(program, config), /nonempty/);
  fs.writeFileSync(file, '{"type":"user","message":{"content":"fixture"}}\n');
  assert.deepEqual(await verifySession(program, config), { id: program.session });
});
