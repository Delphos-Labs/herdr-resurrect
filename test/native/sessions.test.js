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
    state: 'exact', tool: 'opencode', session: 'ses_saved', cwd: os.tmpdir(),
  }, { run: async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ data: { id: 'ses_saved', time: { created: 1234 } } }) };
  } });
  assert.deepEqual(result, { id: 'ses_saved', created: 1234 });
  assert.deepEqual(calls[0][1], ['api', 'get', '/api/session/ses_saved']);
  assert.equal(calls[0][2].cwd, os.tmpdir());
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
  assert.deepEqual(await verifySession(program, config), { id: program.session, transcript: file, startCwd: null });
});

function claudeProfile(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-session-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const write = (folder, body = '{"type":"user","cwd":"/start/dir","message":{"content":"x"}}\n') => {
    fs.mkdirSync(path.join(profile, 'projects', folder), { recursive: true });
    const file = path.join(profile, 'projects', folder, '12345678-1234-1234-1234-123456789abc.jsonl');
    fs.writeFileSync(file, body);
    return file;
  };
  const program = { state: 'exact', tool: 'claude', session: '12345678-1234-1234-1234-123456789abc',
    cwd: '/moved/dir', profile };
  return { profile, write, program };
}

test('Claude finds a transcript stored under the start directory after the session moved', async t => {
  const { write, program } = claudeProfile(t);
  const file = write('-start-dir', '{"type":"summary"}\n{"type":"user","cwd":"/start/dir"}\n{"type":"user","cwd":"/moved/dir"}\n');
  assert.deepEqual(await verifySession(program), { id: program.session, transcript: file, startCwd: '/start/dir' });
});

test('Claude finds a transcript whose folder name Claude shortened', async t => {
  const { write, program } = claudeProfile(t);
  const file = write('-very-long-path-truncated-3f9a2b');
  assert.equal((await verifySession(program)).transcript, file);
});

test('Claude refuses two different transcripts with the same session ID', async t => {
  const { write, program } = claudeProfile(t);
  write('-start-dir');
  write('-other-dir');
  await assert.rejects(verifySession(program), /More than one saved Claude transcript/);
});

test('Claude accepts the same transcript linked under two folders', async t => {
  const { profile, write, program } = claudeProfile(t);
  const file = write('-start-dir');
  fs.mkdirSync(path.join(profile, 'projects', '-moved-dir'));
  fs.linkSync(file, path.join(profile, 'projects', '-moved-dir', path.basename(file)));
  assert.equal((await verifySession(program)).startCwd, '/start/dir');
});

test('Claude refuses a transcript that is a symbolic link', async t => {
  const { profile, program } = claudeProfile(t);
  const real = path.join(profile, 'elsewhere.jsonl');
  fs.writeFileSync(real, '{"type":"user","cwd":"/start/dir"}\n');
  fs.mkdirSync(path.join(profile, 'projects', '-start-dir'), { recursive: true });
  fs.symlinkSync(real, path.join(profile, 'projects', '-start-dir', `${program.session}.jsonl`));
  await assert.rejects(verifySession(program), /not a nonempty file owned by this user/);
});

test('Claude verification does not need the saved directory to exist', async t => {
  const { write, program } = claudeProfile(t);
  write('-start-dir', '{"type":"user","message":{"content":"no directory field"}}\n');
  assert.deepEqual(await verifySession({ ...program, cwd: '/no/such/dir' }),
    { id: program.session, transcript: path.join(program.profile, 'projects', '-start-dir', `${program.session}.jsonl`), startCwd: null });
});

test('OpenCode verification runs from an existing directory and returns the session directory', async () => {
  const calls = [];
  const result = await verifySession({ state: 'exact', tool: 'opencode', session: 'ses_saved', cwd: '/no/such/dir' }, {
    run: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ data: { id: 'ses_saved', directory: '/project', time: { created: 5 } } }) };
    } });
  assert.deepEqual(result, { id: 'ses_saved', created: 5, directory: '/project' });
  assert.equal(calls[0][2].cwd, os.homedir());
});
