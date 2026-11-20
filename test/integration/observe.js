'use strict';

const { spawn } = require('node:child_process');
const { stripVTControlCharacters } = require('node:util');

function observeOutput(binary, env, terminal, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['attach', '--observe', terminal], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error(`No expected output from ${terminal}.`)), timeoutMs);
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
    child.stdout.on('data', data => {
      output = (output + data.toString()).slice(-1024 * 1024);
      const text = stripVTControlCharacters(output);
      if (predicate(text)) done(null, text);
    });
    child.on('error', error => done(error));
    child.on('exit', code => done(new Error(`Observer exited (${code}): ${stderr}`)));
  });
}

module.exports = { observeOutput };
