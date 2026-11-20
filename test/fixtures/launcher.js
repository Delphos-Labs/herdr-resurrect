'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [worker, log, ...args] = process.argv.slice(2);
const fd = fs.openSync(log, 'a', 0o600);
const child = spawn(process.execPath, [worker, ...args], {
  detached: true, env: process.env, stdio: ['ignore', fd, fd],
});
child.unref();
fs.closeSync(fd);
process.stdout.write(JSON.stringify({ pid: child.pid }));
