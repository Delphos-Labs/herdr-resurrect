'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { processStart } = require('../../native/capture');
const { readIdentity } = require('../../native/identity');

test('OpenCode tracker follows root changes without tmux and omits prompts and credentials', async t => {
  const { SessionTracker } = await import('../../integrations/opencode/tui.mjs');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-agent-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let session = 'ses_child';
  let root = 'ses_parent';
  let cwd = '/first-directory';
  const tracker = SessionTracker({
    get location() { return { directory: cwd }; },
    ui: { router: { current: () => ({ type: 'session', sessionID: session }) } },
    data: {
      session: { root: () => root, get: () => ({ prompt: 'private', token: 'secret' }) },
      on: () => () => {},
    },
  }, { stateDir, pollMs: 0, report: message => assert.fail(message) });
  t.after(() => tracker.dispose());
  const file = path.join(stateDir, `opencode-${process.pid}.json`);
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(first.session_id, 'ses_parent');
  assert.equal(first.process_start, processStart(process.pid));
  assert.deepEqual(Object.keys(first).sort(),
    ['cwd', 'pid', 'process_start', 'session_id', 'timestamp', 'tool']);
  session = 'ses_other-child';
  root = 'ses_second-parent';
  cwd = '/second-directory';
  tracker.sync();
  const identity = readIdentity({ pid: process.pid, tool: 'opencode', start: processStart(process.pid) },
    { opencodeStateDir: stateDir });
  assert.equal(identity.state, 'exact');
  assert.equal(identity.session, 'ses_second-parent');
  assert.equal(identity.cwd, '/second-directory');
  tracker.dispose();
  assert.equal(fs.existsSync(file), false);
});

test('tracker refuses symlink directories and records one visible error per reason', async t => {
  const { SessionTracker } = await import('../../integrations/opencode/tui.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-agent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const link = path.join(directory, 'link');
  fs.symlinkSync(directory, link);
  const reports = [];
  const tracker = SessionTracker({
    location: { directory: '/work' },
    ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_one' }) } },
    data: { session: { root: id => id }, on: () => () => {} },
  }, { stateDir: link, pollMs: 0, report: message => reports.push(message) });
  t.after(() => tracker.dispose());
  tracker.sync();
  assert.equal(reports.length, 1);
  assert.match(reports[0], /Unsafe tracker directory/);
  assert.equal(fs.existsSync(path.join(directory, `opencode-${process.pid}.json`)), false);
});
