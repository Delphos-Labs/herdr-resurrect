'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureTool, toolArgv } = require('../../native/tools');

test('only explicit dashboard and monitor commands are admitted', async () => {
  assert.deepEqual(toolArgv(await captureTool(['/bin/btop'], '/work')), ['btop']);
  assert.deepEqual(toolArgv(await captureTool(['/bin/gh', 'dash'], '/work')), ['gh', 'dash']);
  assert.deepEqual(toolArgv(await captureTool(['/bin/gh-dash'], '/work')), ['gh', 'dash']);
  await assert.rejects(captureTool(['gh', 'api', 'repos'], '/work'), /allowlist/);
  await assert.rejects(captureTool(['bash', '-c', 'anything'], '/work'), /allowlist/);
  await assert.rejects(captureTool(['btop', '--arbitrary'], '/work'), /allowlist/);
});

test('tuicr records the exact persisted review without copying annotation text', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'review.md');
  const session = path.join(directory, 'session.json');
  fs.writeFileSync(file, '# Recovery test\n');
  fs.writeFileSync(session, JSON.stringify({
    id: 'review-id', diff_source: 'file', base_commit: 'captured-path-hash', repo_path: directory,
    files: { 'review.md': { path: 'review.md', line_comments: { 1: ['private annotation'] } } },
  }));
  const captured = await captureTool(['tuicr', '--no-update-check', '--file', file, '--line', '1'],
    directory, { list: [{ path: session }] });
  assert.equal(captured.review.session.id, 'review-id');
  assert.ok(!JSON.stringify(captured).includes('private annotation'));
  assert.deepEqual(toolArgv(captured), ['tuicr', '--no-update-check', '--file', file, '--line', '1']);
  fs.writeFileSync(file, '# Changed source\n');
  assert.throws(() => toolArgv(captured), /source changed/);
});

test('ambiguous tuicr sessions are refused instead of selecting the newest', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'review.md');
  fs.writeFileSync(file, '# Review\n');
  const rows = [1, 2].map(id => {
    const target = path.join(directory, `${id}.json`);
    fs.writeFileSync(target, JSON.stringify({
      id: String(id), diff_source: 'file', base_commit: 'captured-path-hash', repo_path: directory,
      files: { 'review.md': { path: 'review.md' } },
    }));
    return { path: target };
  });
  await assert.rejects(captureTool(['tuicr', '--file', file], directory, { list: rows }), /found 2/);
});

test('a matching path in a diff review is not mistaken for a full-file review', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'review.md');
  const session = path.join(directory, 'session.json');
  fs.writeFileSync(file, '# Source\n');
  fs.writeFileSync(session, JSON.stringify({
    id: 'diff-review', diff_source: 'unstaged', base_commit: 'file', repo_path: directory,
    files: { 'review.md': { path: 'review.md' } },
  }));
  await assert.rejects(captureTool(['tuicr', '--file', file], directory,
    { list: [{ path: session }] }), /found 0/);
});
