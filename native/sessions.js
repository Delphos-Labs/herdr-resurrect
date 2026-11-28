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
        cwd: existingDirectory(program.cwd) || os.homedir(), env, timeout: 15000, maxBuffer: 1024 * 1024,
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
    return { id: info.id, created: info.time.created,
      ...(typeof info.directory === 'string' && path.isAbsolute(info.directory) ? { directory: info.directory } : {}) };
  }
  const directory = program.profile || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  if (!path.isAbsolute(directory)) throw new Error('Cannot confirm the Claude profile.');
  const transcript = findTranscript(path.join(directory, 'projects'), program.session);
  return { id: program.session, transcript, startCwd: firstCwd(transcript) };
}

function existingDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
  try { return fs.statSync(directory).isDirectory() ? directory : null; } catch { return null; }
}

// Claude names a transcript folder after the directory the session started in,
// keeps it after the session moves, and shortens long names. Find it by ID.
function findTranscript(projects, session) {
  let folders;
  try { folders = fs.readdirSync(projects, { withFileTypes: true }); } catch { folders = []; }
  const found = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const file = path.join(projects, folder.name, `${session}.jsonl`);
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('The saved Claude transcript is not a nonempty file owned by this user.');
    }
    found.push({ file, key: `${stat.dev}:${stat.ino}` });
  }
  if (!found.length) throw new Error('The saved Claude transcript is missing. Nothing was launched.');
  if (new Set(found.map(item => item.key)).size > 1) {
    throw new Error('More than one saved Claude transcript has this session ID. Nothing was launched.');
  }
  return found.sort((a, b) => a.file.localeCompare(b.file))[0].file;
}

function firstCwd(file, limit = 1024 * 1024) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(limit, fs.fstatSync(descriptor).size));
    const text = buffer.subarray(0, fs.readSync(descriptor, buffer, 0, buffer.length, 0)).toString('utf8');
    for (const line of text.split('\n')) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (typeof record?.cwd === 'string' && path.isAbsolute(record.cwd)) return record.cwd;
    }
    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

// A saved directory can be gone by restore time. Fall back to the directory
// the program's own record names: the conversation's start directory, the
// OpenCode session directory, or the reviewed file's folder.
function launchDirectory(program, session) {
  const candidates = [program.cwd];
  if (program.tool === 'claude') candidates.push(session?.startCwd);
  if (program.tool === 'opencode') candidates.push(session?.directory);
  if (program.tool === 'tuicr' && typeof program.review?.file === 'string') candidates.push(path.dirname(program.review.file));
  if (program.state === 'shell') candidates.push(os.homedir());
  for (const candidate of candidates) {
    const found = existingDirectory(candidate);
    if (found) return found;
  }
  return null;
}

module.exports = { verifySession, existingDirectory, launchDirectory };
