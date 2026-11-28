'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveIdentity, resumeArgv } = require('../../native/identity');

test('same-directory agents retain distinct per-process conversations', () => {
  const a = resolveIdentity({ tool: 'opencode', pid: 101, start: '10', cwd: '/same' },
    { pid: 101, process_start: '10', session_id: 'ses_first' });
  const b = resolveIdentity({ tool: 'opencode', pid: 102, start: '11', cwd: '/same' },
    { pid: 102, process_start: '11', session_id: 'ses_second' });
  assert.equal(a.state, 'exact');
  assert.equal(b.state, 'exact');
  assert.equal(a.session, 'ses_first');
  assert.equal(b.session, 'ses_second');
});

test('PID reuse, missing lifetime evidence and another PID cannot prove identity', () => {
  const processInfo = { tool: 'opencode', pid: 101, start: '20' };
  for (const record of [
    null,
    { pid: 101, process_start: '10', session_id: 'ses_stale' },
    { pid: 101, session_id: 'ses_unproved' },
    { pid: 102, process_start: '20', session_id: 'ses_other' },
  ]) assert.equal(resolveIdentity(processInfo, record).state, 'unresolved');
});

test('current Claude native mapping takes precedence over a stale launch argument', () => {
  const session = '12345678-1234-1234-1234-123456789abc';
  const identity = resolveIdentity({
    tool: 'claude', pid: 9, start: '123', argv: ['claude', '--resume', 'old-session'],
  }, { pid: 9, procStart: '123', sessionId: session });
  assert.equal(identity.session, session);
  assert.deepEqual(resumeArgv(identity), ['claude', '--resume', session]);
});

test('recovery never replays the original prompt, flags or environment', () => {
  const identity = resolveIdentity({ tool: 'opencode', pid: 4, start: '8' }, {
    pid: 4, process_start: '8', session_id: 'ses_saved',
    argv: ['opencode', '--prompt', 'delete everything'],
    env: { API_KEY: 'private' },
  });
  assert.deepEqual(resumeArgv(identity), ['opencode', '-s', 'ses_saved']);
  assert.ok(!Object.hasOwn(identity, 'env'));
  assert.ok(!Object.hasOwn(identity, 'argv'));
});

test('unresolved identities and malformed identifiers cannot become commands', () => {
  assert.throws(() => resumeArgv({ state: 'unresolved', tool: 'opencode', session: 'ses_x' }));
  assert.throws(() => resumeArgv({ state: 'exact', tool: 'opencode', session: 'ses_x;touch /bad' }));
  assert.equal(resolveIdentity({ tool: 'claude', pid: 1, start: '1' },
    { pid: 1, procStart: '1', sessionId: 'not-a-uuid' }).state, 'unresolved');
});

test('a Claude profile is set at launch only when the original process set it', () => {
  const { launchFor } = require('../../native/identity');
  const argv = ['claude', '--resume', '12345678-1234-1234-1234-123456789abc'];
  const caller = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/caller/profile' };
  const swap = { tool: 'claude', profile: '/home/u/.swap/a', profileExplicit: true };
  // The profile goes in argv too, so a shell's own configuration cannot change it.
  assert.deepEqual(launchFor(swap, argv, caller, '/home/u'),
    { argv: ['env', 'CLAUDE_CONFIG_DIR=/home/u/.swap/a', ...argv], env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/home/u/.swap/a' } });
  // Claude reads ~/.claude.json only while the variable is unset, even when it
  // would name ~/.claude. The core's own environment may set it, so remove it in argv.
  const plain = { tool: 'claude', profile: '/home/u/.claude', profileExplicit: false };
  assert.deepEqual(launchFor(plain, argv, caller, '/home/u'),
    { argv: ['env', '-u', 'CLAUDE_CONFIG_DIR', ...argv], env: { PATH: '/bin' } });
});

test('snapshots without the profile flag treat only the default directory as unset', () => {
  const { launchFor } = require('../../native/identity');
  const argv = ['claude', '--resume', '12345678-1234-1234-1234-123456789abc'];
  assert.equal(launchFor({ tool: 'claude', profile: '/home/u/.claude' }, argv, {}, '/home/u').argv[0], 'env');
  assert.deepEqual(launchFor({ tool: 'claude', profile: '/home/u/.other' }, argv, {}, '/home/u'),
    { argv: ['env', 'CLAUDE_CONFIG_DIR=/home/u/.other', ...argv], env: { CLAUDE_CONFIG_DIR: '/home/u/.other' } });
  const opencode = ['opencode', '-s', 'ses_one'];
  assert.deepEqual(launchFor({ tool: 'opencode' }, opencode, { A: '1' }, '/home/u'),
    { argv: opencode, env: { A: '1' } });
});

test('restored programs start through the login shell, so its configuration loads secrets', () => {
  const { throughLoginShell } = require('../../native/identity');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'env'), '#!/bin/sh\n', { mode: 0o700 });
  const env = { PATH: bin };
  const argv = ['env', '-u', 'CLAUDE_CONFIG_DIR', 'A=1', 'claude', '--resume', 'id'];
  const resolved = [path.join(bin, 'env'), '-u', 'CLAUDE_CONFIG_DIR', 'A=1', path.join(bin, 'claude'), '--resume', 'id'];
  assert.deepEqual(throughLoginShell(argv, '/usr/bin/fish', env), ['/usr/bin/fish', '-l', '-c', 'exec $argv', '--', ...resolved]);
  assert.deepEqual(throughLoginShell(argv, '/bin/bash', env), ['/bin/bash', '-l', '-c', 'exec "$@"', 'bash', ...resolved]);
  assert.deepEqual(throughLoginShell(argv, '/usr/bin/zsh', env), ['/usr/bin/zsh', '-l', '-c', 'exec "$@"', 'zsh', ...resolved]);
  assert.deepEqual(throughLoginShell(argv, '/usr/bin/nu', env), argv, 'an unknown shell syntax is not guessed');
  assert.deepEqual(throughLoginShell(argv, '', env), argv);
  fs.rmSync(bin, { recursive: true, force: true });
});

test('the login shell wrapper passes arguments through unchanged and replaces itself', t => {
  const { throughLoginShell } = require('../../native/identity');
  const { spawnSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-login-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const argv = ['/bin/sh', '-c', 'printf "<%s>" "$0" "$@"; echo',
    'zero', '--resume', 'a b', '-i', '$HOME'];
  for (const shell of ['/bin/sh', '/bin/bash', '/usr/bin/fish'].filter(file => fs.existsSync(file))) {
    const result = spawnSync(throughLoginShell(argv, shell)[0], throughLoginShell(argv, shell).slice(1),
      { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
    assert.equal(result.stdout.split('\n')[0], '<zero><--resume><a b><-i><$HOME>', shell);
  }
});
