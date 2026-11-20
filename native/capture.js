'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { validateLayout } = require('./layout');
const { readIdentity } = require('./identity');
const { captureTool, listReviews } = require('./tools');

const execute = promisify(execFile);
const AGENTS = new Set(['opencode', 'claude']);
const SUPPORTED = new Set([...AGENTS, 'tuicr', 'btop', 'gh-dash', 'gh']);

function processStart(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  if (!fields[19]) throw new Error('Missing process start time.');
  return fields[19];
}

async function processInventory() {
  if (process.platform !== 'linux') {
    throw new Error('The checkpoint-1 live process adapter supports Linux only.');
  }
  const { stdout } = await execute('ps', ['-eo', 'pid=,ppid=,comm='], {
    maxBuffer: 16 * 1024 * 1024, timeout: 10000,
  });
  const children = new Map();
  const byPid = new Map();
  for (const line of stdout.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const row = { pid: Number(match[1]), ppid: Number(match[2]), tool: match[3] };
    byPid.set(row.pid, row);
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  return { children, byPid };
}

function panePrograms(pid, inventory) {
  const found = [];
  const queue = inventory.byPid.has(pid) ? [inventory.byPid.get(pid)] : [];
  const seen = new Set();
  for (let i = 0; i < queue.length; i++) {
    const row = queue[i];
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    if (SUPPORTED.has(row.tool)) found.push(row);
    else queue.push(...(inventory.children.get(row.pid) || []));
  }
  return found;
}

function paneAgents(pid, inventory) {
  return panePrograms(pid, inventory).filter(row => AGENTS.has(row.tool));
}

function claudeProfile(pid, fallback) {
  const environment = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  const entry = environment.find(value => value.startsWith('CLAUDE_CONFIG_DIR='));
  const directory = entry?.slice('CLAUDE_CONFIG_DIR='.length) || fallback;
  if (!path.isAbsolute(directory || '')) throw new Error('Claude profile directory is unavailable.');
  return directory;
}

async function captureLocal(core, options) {
  const before = await core.request('doc.get', { name: 'herdr-app' });
  const layout = before.value || { spaces: [] };
  const references = validateLayout(layout);
  const status = await core.request('server.status');
  const listed = await core.request('terminal.list', { all: true });
  const terminals = new Map(listed.terminals.map(terminal => [terminal.address, terminal]));
  const inventory = await (options.inventory || processInventory)();
  const at = Date.now();
  let reviewList;
  const toolOptions = {
    ...options.toolOptions,
    listReviews: () => reviewList ||= listReviews(options.toolOptions),
  };
  const programs = await Promise.all(references.map(async address => {
    const terminal = terminals.get(address);
    if (!terminal || terminal.state !== 'live') {
      return { terminal: address, state: 'unresolved', reason: 'Terminal is not live.' };
    }
    const candidates = panePrograms(terminal.pid, inventory);
    if (candidates.length > 1) {
      return { terminal: address, state: 'unresolved', reason: 'More than one supported program shares this pane.' };
    }
    if (!candidates.length) {
      const row = inventory.byPid.get(terminal.foreground?.pid || terminal.pid);
      const shell = row && ['bash', 'sh', 'zsh', 'fish', 'dash', 'pwsh'].includes(row.tool)
        && !(inventory.children.get(row.pid) || []).length;
      return { terminal: address, state: shell ? 'shell' : 'unsupported',
        cwd: terminal.foreground?.cwd || terminal.cwd,
        reason: shell ? 'Recovery or idle shell.' : 'No supported program was identified.' };
    }
      const candidate = candidates[0];
    try {
      const start = processStart(candidate.pid);
      const cwd = fs.readlinkSync(`/proc/${candidate.pid}/cwd`);
      const profile = candidate.tool === 'claude' ? claudeProfile(candidate.pid, options.claudeConfigDir) : undefined;
      const identity = AGENTS.has(candidate.tool)
        ? readIdentity({ ...candidate, start }, { ...options, ...(profile ? { claudeConfigDir: profile } : {}) })
        : await captureTool(fs.readFileSync(`/proc/${candidate.pid}/cmdline`, 'utf8')
          .split('\0').filter(Boolean), cwd, toolOptions);
      if (processStart(candidate.pid) !== start) throw new Error('Process changed during capture.');
      return { terminal: address, cwd, ...identity,
        ...(profile ? { profile } : {}),
        ...(['exact', 'tool'].includes(identity.state) ? { verified_at: at } : {}) };
    } catch (error) {
      return { terminal: address, state: 'unresolved',
        reason: `Process inspection failed: ${error.code || error.message}` };
    }
  }));
  const after = await core.request('doc.get', { name: 'herdr-app' });
  if (before.version !== after.version) throw new Error('Layout changed during capture; snapshot not saved.');
  return {
    format: 1, host: options.host, boot: options.boot, at,
    core: { id: status.core.id, version: status.version },
    layout, programs,
    ended: listed.terminals.filter(terminal => terminal.state === 'finished').map(terminal => ({
      terminal: terminal.address, reason: terminal.reason, exitCode: terminal.exit_code,
    })),
  };
}

module.exports = { captureLocal, paneAgents, panePrograms, processInventory, processStart };
