'use strict';

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  process.title = process.env.TEST_TOOL;
  if (process.env.TEST_TOOL === 'opencode') {
    const { SessionTracker } = await import('../../integrations/opencode/tui.mjs');
    const tracker = SessionTracker({
      location: { directory: process.cwd() },
      ui: { router: { current: () => ({ type: 'session', sessionID: process.env.TEST_SESSION }) } },
      data: { session: { root: id => id }, on: () => () => {} },
    }, { stateDir: process.env.TEST_RECORDS, pollMs: 0, report: message => { throw new Error(message); } });
    process.on('exit', tracker.dispose);
  } else {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
    const file = path.join(process.env.TEST_RECORDS, 'sessions', `${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({
      pid: process.pid, procStart: start, sessionId: process.env.TEST_SESSION,
    }), { mode: 0o600 });
  }
  fs.writeFileSync(process.env.TEST_READY, String(process.pid));
  process.stdin.resume();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
