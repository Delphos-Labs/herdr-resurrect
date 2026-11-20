'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SnapshotStore, snapshotDigest } = require('../../native/store');
const { snapshot } = require('./fixtures');

test('verified original conversations unlock saving in a new boot', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-reconcile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SnapshotStore(directory);
  const saved = snapshot();
  store.save(saved);
  const fresh = snapshot({ at: 200, boot: 'new-boot' });
  assert.equal(store.save(fresh).reason, 'recovery-pending');
  assert.equal(store.save(fresh, { reconciledAgainst: snapshotDigest(saved) }).saved, true);
  assert.equal(store.save(snapshot({ at: 300, boot: 'new-boot' })).saved, true);
});

test('wrong conversations, stale observations and changed saved state cannot acknowledge recovery', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-reconcile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SnapshotStore(directory);
  const saved = snapshot();
  store.save(saved);
  const fresh = snapshot({ at: 200, boot: 'new-boot' });
  fresh.programs[0].session = 'ses_wrong';
  assert.throws(() => store.save(fresh, { reconciledAgainst: snapshotDigest(saved) }), /Conversation changed/);
  fresh.programs[0].session = 'ses_one';
  fresh.programs[0].observed = { state: 'shell' };
  assert.throws(() => store.save(fresh, { reconciledAgainst: snapshotDigest(saved) }), /not verified/);
  delete fresh.programs[0].observed;
  assert.throws(() => store.save(fresh, { reconciledAgainst: 'old-digest' }), /state changed/);
  assert.deepEqual(store.load(), saved);
});
