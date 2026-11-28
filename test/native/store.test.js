'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SnapshotStore } = require('../../native/store');
const { snapshot } = require('./fixtures');

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'resurrect-store-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

test('durable snapshots retain exact IDs after a new store opens', t => {
  const dir = directory(t);
  new SnapshotStore(dir).save(snapshot());
  assert.deepEqual(new SnapshotStore(dir).load(), snapshot());
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'last.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});

test('an interrupted atomic replacement leaves the last good snapshot', t => {
  const dir = directory(t);
  new SnapshotStore(dir).save(snapshot());
  const broken = new SnapshotStore(dir, { beforeRename: () => { throw new Error('power loss'); } });
  assert.throws(() => broken.save(snapshot({ at: 200 })), /power loss/);
  assert.deepEqual(new SnapshotStore(dir).load(), snapshot());
});

test('a reboot cannot overwrite pre-stop conversations with shells or new work', t => {
  const store = new SnapshotStore(directory(t));
  store.save(snapshot());
  const shells = snapshot({ at: 200, boot: 'boot-b',
    programs: [{ terminal: 't1', state: 'shell' }, { terminal: 't2', state: 'shell' }] });
  assert.equal(store.save(shells).reason, 'recovery-pending');
  assert.equal(store.save(snapshot({ at: 300, boot: 'boot-b' })).reason, 'recovery-pending');
  assert.equal(store.load().at, 100);
});

test('empty captures need confirmation, and late captures cannot roll back state', t => {
  const store = new SnapshotStore(directory(t));
  store.save(snapshot());
  assert.equal(store.save(snapshot({ at: 200, layout: { spaces: [] }, programs: [] })).saved, false);
  assert.throws(() => store.save(snapshot({ at: 50 })), /older/);
  assert.throws(() => store.save(snapshot({ at: 200, host: 'another-host' })), /host identity changed/);
});

test('explicit closes can save an empty workspace, but process crashes cannot erase recovery', t => {
  const store = new SnapshotStore(directory(t));
  store.save(snapshot());
  const empty = snapshot({
    at: 200, layout: { spaces: [] }, programs: [],
    ended: [
      { terminal: 't1', reason: 'exited', exitCode: 1 },
      { terminal: 't2', reason: 'killed', exitCode: null },
    ],
  });
  assert.equal(store.save(empty).reason, 'empty-state-needs-confirmation');
  empty.ended[0].exitCode = 0;
  assert.equal(store.save(empty).saved, true);
  assert.equal(store.load().programs.length, 0);
});

test('retention is bounded and malformed state is not silently replaced', t => {
  const dir = directory(t);
  const store = new SnapshotStore(dir, { retain: 2 });
  for (const at of [100, 200, 300]) store.save(snapshot({ at }));
  assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('snapshot-')).length, 2);
  fs.writeFileSync(path.join(dir, 'last.json'), '{broken');
  assert.throws(() => store.save(snapshot({ at: 400 })), SyntaxError);
  assert.equal(fs.readFileSync(path.join(dir, 'last.json'), 'utf8'), '{broken');
});

test('another writer lock is preserved and unsafe directories are refused', t => {
  const dir = directory(t);
  const store = new SnapshotStore(dir);
  fs.mkdirSync(path.join(dir, '.capture.lock'));
  assert.throws(() => store.save(snapshot()), { code: 'ELOCKED' });
  assert.equal(fs.statSync(path.join(dir, '.capture.lock')).isDirectory(), true);
  assert.throws(() => new SnapshotStore('relative/path'), /absolute/);
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'link');
    fs.symlinkSync(dir, link);
    assert.throws(() => new SnapshotStore(link), /Unsafe/);
  }
});

test('an expired lock from an abrupt stop does not block future captures forever', t => {
  const dir = directory(t);
  const store = new SnapshotStore(dir);
  store.save(snapshot());
  const lock = path.join(dir, '.capture.lock');
  fs.mkdirSync(lock);
  const expired = new Date(Date.now() - 60000);
  fs.utimesSync(lock, expired, expired);
  assert.equal(store.save(snapshot({ at: 200 })).saved, true);
  assert.equal(store.load().at, 200);
});

test('partial agent loss retains its known conversation without marking its identity fresh', t => {
  const store = new SnapshotStore(directory(t));
  store.save(snapshot());
  const next = snapshot({
    at: 200,
    programs: [
      { terminal: 't1', state: 'shell', reason: 'Lost program recovered as a shell.' },
      { terminal: 't2', state: 'exact', tool: 'claude', session: '12345678-1234-1234-1234-123456789abc' },
    ],
  });
  store.save(next);
  const retained = store.load().programs[0];
  assert.equal(retained.session, 'ses_one');
  assert.equal(retained.verified_at, 100);
  assert.equal(retained.observed.state, 'shell');
  assert.equal(next.programs[0].state, 'shell');
});
