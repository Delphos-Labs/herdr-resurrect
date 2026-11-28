'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isolatedCore } = require('./helpers');
const { CoreClient } = require('../../native/core');

test('a parent socket binds the exact core despite unrelated XDG settings and never starts another core', async t => {
  const core = isolatedCore(t);
  const socket = path.join(core.env.XDG_RUNTIME_DIR, 'herdr-core/proof.sock');
  const parent = new CoreClient({ socket, env: { XDG_RUNTIME_DIR: '/unrelated' }, binary: '/does-not-exist' });
  core.beforeStop(() => parent.close());
  assert.equal((await parent.request('hello')).core.id, core.coreId);
  assert.equal(parent.child, undefined);
  assert.throws(() => new CoreClient({ socket: path.join(core.root, 'missing.sock') }), { code: 'ENOENT' });
});
