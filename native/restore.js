'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const lockfile = require('proper-lockfile');
const { validateLayout, remapLayout } = require('./layout');
const { validateSnapshot } = require('./store');
const { resumeArgv, launchFor } = require('./identity');
const { toolArgv } = require('./tools');
const { verifySession: defaultVerifySession } = require('./sessions');
const { readPending, requestResume } = require('./pending');

function panes(document) {
  const result = new Map();
  function visit(node, space, tab) {
    if (node.type === 'block') result.set(node.id, { node, space, tab, terminal: node.content.terminal });
    else node.children.forEach(child => visit(child, space, tab));
  }
  for (const space of document.spaces) for (const tab of space.tabs) visit(tab.root, space.id, tab.id);
  return result;
}

function structure(node) {
  return {
    id: node.id, type: node.type, size: node.size,
    ...(node.children ? { children: node.children.map(structure) } : {}),
  };
}

function mergeLayout(saved, current, replacements) {
  const restored = remapLayout(saved, replacements);
  const result = structuredClone(current);
  for (const space of restored.spaces) {
    const existing = result.spaces.find(item => item.id === space.id);
    if (!existing) {
      result.spaces.push(space);
      continue;
    }
    for (const tab of space.tabs) {
      const active = existing.tabs.find(item => item.id === tab.id);
      if (!active) existing.tabs.push(tab);
      else {
        if (!isDeepStrictEqual(structure(active.root), structure(tab.root))) {
          throw new Error(`Layout changed for tab ${tab.id}; refusing to overwrite it.`);
        }
        const targets = panes({ spaces: [{ ...space, tabs: [tab] }] });
        function update(node) {
          if (node.type === 'block') node.content.terminal = targets.get(node.id).terminal;
          else node.children.forEach(update);
        }
        update(active.root);
      }
    }
  }
  validateLayout(result);
  return result;
}

async function planRestore(core, snapshot, { host, stateDir, env = process.env, verifySession = defaultVerifySession }) {
  validateSnapshot(snapshot);
  if (snapshot.host !== host) throw new Error('Snapshot belongs to another host.');
  const handshake = await core.request('hello');
  if (!/^0\.1\./.test(handshake.version || '')) throw new Error('Unsupported core adapter version.');
  const current = await core.request('doc.get', { name: 'herdr-app' });
  current.value ||= { spaces: [] };
  validateLayout(current.value);
  const livePanes = panes(current.value);
  const listed = await core.request('terminal.list', { all: true });
  const byAddress = new Map(listed.terminals.map(terminal => [terminal.address, terminal]));
  const records = new Map(snapshot.programs.map(program => [program.terminal, program]));
  const actions = [];
  const replacements = {};
  for (const [pane, source] of panes(snapshot.layout)) {
    const program = records.get(source.terminal);
    const live = listed.terminals.filter(terminal => terminal.state === 'live'
      && (terminal.address === livePanes.get(pane)?.terminal
        || (terminal.labels?.['resurrect.host'] === host && terminal.labels?.['resurrect.pane'] === pane)));
    if (live.length > 1) throw new Error(`More than one live terminal claims pane ${pane}.`);
    if (live.length) {
      replacements[source.terminal] = live[0].address;
      const pending = stateDir && handshake.core?.id
        ? readPending(stateDir, live[0], { host, coreId: handshake.core.id }) : null;
      if (pending) {
        if (!['exact', 'tool'].includes(program.state)) throw new Error('Waiting pane has no supported saved program.');
        const session = program.state === 'exact' ? await verifySession(program, { env }) : undefined;
        actions.push({
          action: 'resume-in-place', pane, source: source.terminal, terminal: live[0].address,
          space: source.space, tab: source.tab, cwd: program.cwd,
          argv: program.state === 'exact' ? resumeArgv(program) : toolArgv(program),
          pending, ...(session ? { session } : {}),
        });
        continue;
      }
      actions.push({ action: 'keep-live', pane, source: source.terminal, terminal: live[0].address,
        space: source.space, tab: source.tab });
      continue;
    }
    if (byAddress.get(source.terminal)?.state === 'live') {
      throw new Error(`Saved terminal ${source.terminal} is live outside its expected pane.`);
    }
    if (!['exact', 'tool', 'shell'].includes(program.state)) {
      throw new Error(`Pane ${pane} has no exact supported restore record.`);
    }
    if (!path.isAbsolute(program.cwd || '') || !fs.statSync(program.cwd).isDirectory()) {
      throw new Error(`Saved working directory is unavailable for pane ${pane}.`);
    }
    const session = program.state === 'exact' ? await verifySession(program, { env }) : undefined;
    if (Number.isFinite(session?.created) && session.created > snapshot.at) {
      throw new Error('The conversation was created after this snapshot; refusing an empty replacement.');
    }
    actions.push({
      action: 'launch', pane, source: source.terminal, space: source.space, tab: source.tab,
      cwd: program.cwd, argv: program.state === 'exact' ? resumeArgv(program)
        : program.state === 'shell' ? [] : toolArgv(program),
      ...(session ? { session } : {}),
    });
    replacements[source.terminal] = `pending-${pane}`;
  }
  mergeLayout(snapshot.layout, current.value, replacements);
  return { current, actions, replacements, coreId: handshake.core?.id || null };
}

async function restore(core, snapshot, { stateDir, host, env = {}, verifySession = defaultVerifySession, expected }) {
  if (!path.isAbsolute(stateDir || '')) throw new Error('An absolute restore state directory is required.');
  const release = await lockfile.lock(stateDir, {
    lockfilePath: path.join(stateDir, '.restore.lock'), stale: 30000, update: 10000,
  });
  const run = randomUUID();
  const created = [];
  let resumed = 0;
  let committed = false;
  try {
    const launchEnv = { ...process.env, ...env };
    const plan = await planRestore(core, snapshot, { host, stateDir, env: launchEnv, verifySession });
    if (expected && (expected.coreId !== plan.coreId || expected.version !== plan.current.version)) {
      throw new Error('The core or layout changed after preview. Preview again.');
    }
    for (const action of plan.actions) {
      if (!['launch', 'resume-in-place'].includes(action.action)) continue;
      const before = await core.request('doc.get', { name: 'herdr-app' });
      if (before.version !== plan.current.version) throw new Error('Layout changed before launch.');
      const program = snapshot.programs.find(item => item.terminal === action.source);
      if (program.state === 'exact') {
        const checked = await verifySession(program, { env: launchEnv });
        if (!isDeepStrictEqual(checked, action.session)) {
          throw new Error('The saved session changed between preview and launch.');
        }
      }
      if (action.action === 'resume-in-place') {
        const terminal = await core.request('terminal.get', { terminal: action.terminal });
        const pending = readPending(stateDir, terminal, { host, coreId: plan.coreId });
        if (!pending || pending.nonce !== action.pending.nonce) throw new Error('Waiting recovery process changed.');
        requestResume(stateDir, pending, program);
        resumed++;
        continue;
      }
      const launch = launchFor(program, action.argv, env);
      const terminal = await core.request('terminal.run', {
        argv: launch.argv, cwd: action.cwd, env: launch.env, no_parent: true, no_notify: true,
        outlive_parent: true, keep: true,
        labels: { 'resurrect.host': host, 'resurrect.pane': action.pane, 'resurrect.run': run },
      });
      created.push(terminal.address);
      if (terminal.state !== 'live') throw new Error(`Program did not start for pane ${action.pane}.`);
      action.terminal = terminal.address;
      plan.replacements[action.source] = terminal.address;
    }
    const value = mergeLayout(snapshot.layout, plan.current.value, plan.replacements);
    if (!isDeepStrictEqual(value, plan.current.value)) {
      await core.request('doc.set', { name: 'herdr-app', version: plan.current.version, value });
    }
    committed = true;
    const labels = [];
    for (const action of plan.actions) {
      try {
        await core.request('terminal.label', {
          terminal: action.terminal, labels: { 'herdr.space': action.space, 'herdr.tab': action.tab },
        });
      } catch (error) {
        labels.push({ terminal: action.terminal, error: error.message });
      }
    }
    return { actions: plan.actions, started: created.length + resumed, resumedInPlace: resumed, verified: false, labels };
  } catch (error) {
    if (!committed) {
      const cleanupErrors = [];
      for (const address of created) {
        try {
          const terminal = await core.request('terminal.get', { terminal: address });
          if (terminal.labels?.['resurrect.run'] !== run) {
            throw new Error('Restore no longer owns the newly created terminal.');
          }
          await core.request('terminal.kill', { terminal: address });
        } catch (cleanup) {
          cleanupErrors.push({ terminal: address, error: cleanup.message });
        }
      }
      if (cleanupErrors.length) error.cleanup = cleanupErrors;
    }
    if (resumed) error.resumedInPlace = resumed;
    throw error;
  } finally {
    await release();
  }
}

module.exports = { planRestore, restore, mergeLayout, layoutPanes: panes };
