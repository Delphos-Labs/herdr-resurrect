#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { planInstall, applyInstall } = require('../native/install');
const { readJson, privateDirectory, atomicJson } = require('../native/store');

const { values, positionals } = parseArgs({
  options: { output: { type: 'string' }, plan: { type: 'string' }, prefix: { type: 'string' },
    activate: { type: 'boolean', default: false } }, allowPositionals: true,
});
try {
  if (process.platform !== 'linux') throw new Error('The installer currently supports Linux and WSL only.');
  if (positionals.length !== 1) throw new Error('Choose plan or apply.');
  if (positionals[0] === 'plan') {
    if (!path.isAbsolute(values.output || '')) throw new Error('--output must name an absolute private plan file.');
    const result = planInstall(values.prefix ? { prefix: values.prefix } : {});
    privateDirectory(path.dirname(values.output));
    atomicJson(path.dirname(values.output), path.basename(values.output), result);
    process.stdout.write(JSON.stringify({ plan: values.output, prefix: result.prefix,
      files: result.files.map(file => file.path), activation: result.commands }) + '\n');
  } else if (positionals[0] === 'apply') {
    if (!path.isAbsolute(values.plan || '')) throw new Error('--plan must name the reviewed plan file.');
    const plan = readJson(values.plan);
    if (!plan) throw new Error('The reviewed installation plan is missing.');
    process.stdout.write(JSON.stringify(applyInstall(plan, { activate: values.activate })) + '\n');
  } else throw new Error('Unknown installation operation.');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
}
