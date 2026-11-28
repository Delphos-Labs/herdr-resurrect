'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);

function digest(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Unsupported review source size or type.');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function listReviews({ binary = 'tuicr', env = process.env } = {}) {
  return JSON.parse((await execute(binary, ['review', 'list', '--all'], {
    env, timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  })).stdout);
}

async function reviewIdentity(file, options = {}) {
  const canonical = fs.realpathSync(file);
  const rows = options.list || await (options.listReviews || listReviews)(options);
  const matches = [];
  for (const row of rows) {
    let session;
    try {
      session = JSON.parse(fs.readFileSync(row.path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Cannot inspect persisted reviews: ${error.code || 'invalid private review record'}`);
    }
    if (session.diff_source !== 'file' || !path.isAbsolute(session.repo_path || '')) continue;
    if (Object.values(session.files || {}).some(item =>
      path.resolve(session.repo_path, item.path) === canonical)) {
      matches.push({ path: row.path, id: session.id });
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one persisted review, found ${matches.length}.`);
  if (!path.isAbsolute(matches[0].path || '') || typeof matches[0].id !== 'string') {
    throw new Error('Unsupported persisted review identity.');
  }
  return { file: canonical, sha256: digest(canonical), session: matches[0] };
}

async function captureTool(argv, cwd, options = {}) {
  const name = path.basename(argv[0] || '');
  if (name === 'btop' && argv.length === 1) return { state: 'tool', tool: 'btop', cwd };
  if (name === 'gh-dash' || (name === 'gh' && argv[1] === 'dash')) {
    const flags = argv.slice(name === 'gh' ? 2 : 1);
    if (!flags.length) return { state: 'tool', tool: 'gh-dash', cwd };
    if (flags.length === 2 && ['--config', '-c'].includes(flags[0])) {
      const file = fs.realpathSync(path.resolve(cwd, flags[1]));
      return { state: 'tool', tool: 'gh-dash', cwd, config: { file, sha256: digest(file) } };
    }
    throw new Error('Dashboard arguments are not on the restore allowlist.');
  }
  if (name === 'tuicr') {
    const args = argv.slice(1);
    let file;
    let line;
    while (args.length) {
      const flag = args.shift();
      if (flag === '--no-update-check') continue;
      if (flag === '--file' && !file && args.length) file = path.resolve(cwd, args.shift());
      else if (flag === '--line' && !line && /^\d+$/.test(args[0] || '') && Number(args[0]) > 0) {
        line = Number(args.shift());
      } else throw new Error('Unsupported tuicr argument or review scope.');
    }
    if (!file) throw new Error('Only full-file tuicr reviews are supported by this adapter.');
    return { state: 'tool', tool: 'tuicr', cwd,
      review: await reviewIdentity(file, options), ...(line ? { line } : {}) };
  }
  throw new Error('Tool or arguments are not on the restore allowlist.');
}

function toolArgv(program) {
  if (program.state !== 'tool') throw new Error('A captured tool record is required.');
  if (program.tool === 'btop') return ['btop'];
  if (program.tool === 'gh-dash') {
    const argv = ['gh', 'dash'];
    if (program.config) {
      if (!path.isAbsolute(program.config.file || '')
        || digest(program.config.file) !== program.config.sha256) {
        throw new Error('Dashboard configuration changed since capture.');
      }
      argv.push('--config', program.config.file);
    }
    return argv;
  }
  if (program.tool === 'tuicr') {
    const review = program.review;
    if (!review || !path.isAbsolute(review.file || '') || !path.isAbsolute(review.session?.path || '')) {
      throw new Error('Missing persisted review identity.');
    }
    if (digest(review.file) !== review.sha256) throw new Error('Review source changed since capture.');
    const session = JSON.parse(fs.readFileSync(review.session.path, 'utf8'));
    if (session.id !== review.session.id || session.diff_source !== 'file'
      || !Object.values(session.files || {}).some(item =>
        path.resolve(session.repo_path, item.path) === review.file)) {
      throw new Error('Persisted review no longer matches the captured source.');
    }
    const argv = ['tuicr', '--no-update-check', '--file', review.file];
    if (program.line) {
      if (!Number.isInteger(program.line) || program.line < 1) throw new Error('Invalid review line.');
      argv.push('--line', String(program.line));
    }
    return argv;
  }
  throw new Error('Tool is not on the restore allowlist.');
}

module.exports = { captureTool, toolArgv, reviewIdentity, listReviews };
