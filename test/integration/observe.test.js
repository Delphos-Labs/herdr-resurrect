'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isolatedCore } = require('./helpers');
const { observeOutput } = require('./observe');

test('read-only observer receives existing screen output without polling', async t => {
  const core = isolatedCore(t);
  const terminal = await core.client.request('terminal.run', {
    argv: [process.execPath, '-e',
      'console.log("OBSERVABLE_TERMINAL"); process.stdin.resume()'],
    no_parent: true, no_notify: true, outlive_parent: true,
  });
  const text = await observeOutput(core.hc, core.env, terminal.address,
    output => output.includes('OBSERVABLE_TERMINAL'));
  assert.ok(text.includes('OBSERVABLE_TERMINAL'));
});

test('read-only observer also receives output generated after attachment', async t => {
  const core = isolatedCore(t);
  const terminal = await core.client.request('terminal.run', {
    argv: [process.execPath, '-e',
      'console.log("READY"); setTimeout(() => console.log("LIVE_AFTER_ATTACH"), 1000); process.stdin.resume()'],
    no_parent: true, no_notify: true, outlive_parent: true,
  });
  const text = await observeOutput(core.hc, core.env, terminal.address,
    output => output.includes('LIVE_AFTER_ATTACH'), 5000);
  assert.ok(text.includes('LIVE_AFTER_ATTACH'));
});
