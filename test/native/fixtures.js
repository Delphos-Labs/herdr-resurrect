'use strict';

function layout(terminals = ['t1', 't2']) {
  return {
    spaces: [{
      id: 'sp-work', name: 'Work', folder: '/work',
      tabs: [{
        id: 'tb-agents', name: 'Agents',
        root: {
          id: 'split', type: 'row', children: terminals.map((terminal, i) => ({
            id: `pane-${i}`, type: 'block', size: { weight: i + 1 },
            content: { terminal },
          })),
        },
      }],
    }],
  };
}

function snapshot(overrides = {}) {
  return {
    format: 1, host: 'host-a', boot: 'boot-a', at: 100,
    layout: layout(),
    programs: [
      { terminal: 't1', state: 'exact', tool: 'opencode', session: 'ses_one' },
      { terminal: 't2', state: 'exact', tool: 'claude', session: '12345678-1234-1234-1234-123456789abc' },
    ],
    ...overrides,
  };
}

module.exports = { layout, snapshot };
