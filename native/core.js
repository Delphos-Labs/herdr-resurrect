'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

class CoreClient {
  constructor({ binary = 'hc', env = process.env, socket, timeoutMs = 10000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    if (socket) {
      if (!path.isAbsolute(socket)) throw new Error('An absolute parent core socket is required.');
      const stat = fs.lstatSync(socket);
      if (!stat.isSocket() || stat.isSymbolicLink()
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        throw new Error('Parent core socket is not owned by this user.');
      }
      this.socket = net.createConnection(socket);
      this.reader = this.socket;
      this.writer = this.socket;
      this.socket.on('close', () => this.fail(new Error('The parent core connection closed.')));
    } else {
      this.child = spawn(binary, ['connect'], {
        env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.reader = this.child.stdout;
      this.writer = this.child.stdin;
      // Drain diagnostics without putting terminal commands or private paths in errors.
      this.child.stderr.resume();
      this.child.on('error', error => this.fail(error));
      this.child.on('exit', () => this.fail(new Error('The core connection closed.')));
    }
    this.lines = readline.createInterface({ input: this.reader });
    this.lines.on('line', line => {
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        this.fail(new Error('The core returned invalid JSON.'));
        return;
      }
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.error) {
        const error = new Error(reply.error.message || 'Core request failed.');
        error.kind = reply.error.data?.kind;
        request.reject(error);
      } else {
        request.resolve(reply.result);
      }
    });
    this.writer.on('error', error => this.fail(error));
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.lines.close();
    this.child?.kill();
    this.socket?.destroy();
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('The core connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Core request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writer.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  close() {
    this.fail(new Error('The core connection was closed by the caller.'));
  }
}

module.exports = { CoreClient };
