#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { readConfig } = require('../native/config');
const { HostControl } = require('../native/control');

async function main() {
  const { values, positionals } = parseArgs({
    options: { config: { type: 'string' }, snapshot: { type: 'string' }, ticket: { type: 'string' } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw new Error('Choose status, list, capture, preview, restore or reconcile.');
  const action = positionals[0];
  if (!['status', 'list', 'capture', 'preview', 'restore', 'reconcile'].includes(action)) {
    throw new Error('Unknown native recovery operation.');
  }
  if (values.snapshot && action !== 'preview' || values.ticket && action !== 'restore') {
    throw new Error('Snapshot and ticket options do not apply to this operation.');
  }
  if (process.platform !== 'linux') throw new Error('This host adapter currently requires Linux or WSL.');
  const host = new HostControl(readConfig(values.config));
  const result = action === 'status' ? host.status()
    : action === 'list' ? host.snapshots()
      : action === 'capture' ? await host.capture()
        : action === 'preview' ? await host.preview(values.snapshot)
          : action === 'restore' ? await host.restore(values.ticket)
            : await host.reconcile();
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message,
    ...(error.resumedInPlace ? { resumedInPlace: error.resumedInPlace } : {}) }) + '\n');
  process.exitCode = 1;
});
