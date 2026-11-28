'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CoreClient } = require('./core');
const { hostOptions, coreEnv } = require('./config');
const {
  SnapshotStore, privateDirectory, readJson, atomicJson, snapshotDigest,
} = require('./store');
const { captureLocal, processStart } = require('./capture');
const { planRestore, restore } = require('./restore');

class HostControl {
  constructor(config, { connect } = {}) {
    this.config = config;
    this.store = new SnapshotStore(config.stateDir);
    this.options = hostOptions(config);
    this.connect = connect || (() => new CoreClient({ binary: config.hc, env: coreEnv(config) }));
  }

  status() {
    const saved = this.store.load();
    let health = readJson(path.join(this.config.stateDir, 'health.json'));
    const receipt = readJson(path.join(this.config.stateDir, 'last-restore.json'));
    const lastRestore = receipt?.boot === this.options.boot ? receipt : null;
    if (lastRestore?.verified && lastRestore.snapshotAt === saved?.at && saved.boot === this.options.boot && health) {
      health = { ...health, pending: null };
    }
    let recorderActive = false;
    try {
      recorderActive = Boolean(health && health.boot === this.options.boot
        && processStart(health.pid) === health.start);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
    return {
      host: this.options.host, boot: this.options.boot, intervalMs: this.config.intervalMs,
      health, recorderActive, lastRestore, snapshot: saved ? {
        at: saved.at, boot: saved.boot, programs: saved.programs.length,
        unresolved: saved.programs.filter(item => item.observed
          || ['unresolved', 'unsupported'].includes(item.state)).length,
      } : null,
    };
  }

  snapshots() {
    return this.store.list().map(({ name, snapshot }) => ({
      name, at: snapshot.at, boot: snapshot.boot, programs: snapshot.programs.length,
    }));
  }

  async withCore(action) {
    const core = this.connect();
    try { return await action(core); } finally { core.close(); }
  }

  async capture() {
    return this.withCore(async core => {
      const snapshot = await captureLocal(core, this.options);
      const result = this.store.save(snapshot);
      return { saved: result.saved, at: result.snapshot.at, pending: result.reason || null };
    });
  }

  async preview(name) {
    const selected = name ? this.store.list().find(item => item.name === name)?.snapshot : this.store.load();
    if (!selected) throw new Error('No matching snapshot is available.');
    return this.withCore(async core => {
      const plan = await planRestore(core, selected, {
        stateDir: this.config.stateDir, host: this.options.host, env: coreEnv(this.config),
      });
      const ticket = randomUUID();
      const directory = path.join(this.config.stateDir, 'previews');
      privateDirectory(directory);
      for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const file = path.join(directory, name);
        const old = readJson(file);
        if (old?.version === 1 && Date.now() - old.at > 300000) fs.unlinkSync(file);
      }
      atomicJson(directory, `${ticket}.json`, {
        version: 1, at: Date.now(), host: this.options.host, snapshot: selected,
        expected: { coreId: plan.coreId, version: plan.current.version },
      });
      return { ticket, snapshotAt: selected.at, actions: plan.actions.map(action => ({
        action: action.action, pane: action.pane, cwd: action.cwd, ...(action.savedCwd ? { savedCwd: action.savedCwd } : {}),
        terminal: action.terminal || null, command: action.argv || [],
      })) };
    });
  }

  async restore(ticket) {
    if (!/^[a-f0-9-]{36}$/.test(ticket || '')) throw new Error('A reviewed preview ticket is required.');
    const directory = path.join(this.config.stateDir, 'previews');
    const file = path.join(directory, `${ticket}.json`);
    const claimed = path.join(directory, `${ticket}.claimed`);
    fs.renameSync(file, claimed);
    try {
      const request = readJson(claimed);
      if (request?.version !== 1 || request.host !== this.options.host
        || Date.now() - request.at > 300000 || request.at > Date.now()) {
        throw new Error('The preview is invalid or expired. Preview again.');
      }
      const report = await this.withCore(core => restore(core, request.snapshot, {
        stateDir: this.config.stateDir, host: this.options.host,
        expected: request.expected,
      }));
      const result = {
        at: Date.now(), boot: this.options.boot, started: report.started, resumedInPlace: report.resumedInPlace,
        verified: false, labelErrors: report.labels,
      };
      atomicJson(this.config.stateDir, 'last-restore.json', result);
      return result;
    } finally {
      fs.unlinkSync(claimed);
    }
  }

  async reconcile() {
    const saved = this.store.load();
    if (!saved) throw new Error('There is no saved recovery state to verify.');
    return this.withCore(async core => {
      const fresh = await captureLocal(core, this.options);
      const result = this.store.save(fresh, { reconciledAgainst: snapshotDigest(saved) });
      atomicJson(this.config.stateDir, 'last-restore.json', {
        at: Date.now(), boot: this.options.boot, verified: true, snapshotAt: result.snapshot.at,
      });
      return { verified: true, at: result.snapshot.at };
    });
  }
}

module.exports = { HostControl };
