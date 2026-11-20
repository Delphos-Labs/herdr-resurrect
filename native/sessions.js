'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resumeArgv } = require('./identity');

const execute = promisify(execFile);

async function verifySession(program, { env = process.env, run = execute } = {}) {
  resumeArgv(program);
  if (program.tool === 'opencode') {
    let response;
    try {
      response = JSON.parse((await run('opencode', ['api', 'get', `/api/session/${program.session}`], {
        cwd: program.cwd, env, timeout: 15000, maxBuffer: 1024 * 1024,
      })).stdout);
    } catch {
      throw new Error('Cannot confirm the saved OpenCode session. Nothing was launched.');
    }
    const info = response.data || response;
    if (info.id !== program.session || !Number.isFinite(info.time?.created)) {
      throw new Error('OpenCode returned a different or invalid session identity.');
    }
    if (program.sessionCreated !== undefined && program.sessionCreated !== info.time.created) {
      throw new Error('The saved OpenCode session was replaced with another conversation.');
    }
    return { id: info.id, created: info.time.created };
  }
  const directory = program.profile || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  if (!path.isAbsolute(directory) || !path.isAbsolute(program.cwd || '')) {
    throw new Error('Cannot confirm the Claude profile or working directory.');
  }
  const project = program.cwd.replace(/[^A-Za-z0-9]/g, '-');
  const file = path.join(directory, 'projects', project, `${program.session}.jsonl`);
  let stat;
  try { stat = fs.lstatSync(file); } catch {
    throw new Error('The saved Claude transcript is missing. Nothing was launched.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('The saved Claude transcript is not a nonempty file owned by this user.');
  }
  return { id: program.session };
}

module.exports = { verifySession };
