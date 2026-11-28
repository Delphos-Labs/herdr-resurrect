'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');

const fixture = { calls: [], reply: { code: 0, stdout: '{}', stderr: '' } };
globalThis.resurrectModFixture = fixture;

registerHooks({
  resolve(specifier, context, next) {
    if (['herdr', 'gpui-kit', 'gpui-base'].includes(specifier)) {
      return { url: `resurrect-mock:${specifier}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const modules = {
      'resurrect-mock:gpui-kit': `
        export class View {}
        export function div() {
          const node = { childNodes: [], attributes: {} };
          const proxy = new Proxy(node, { get(target, method) {
            if (method in target) return target[method];
            return (...args) => {
              if (method === "child") target.childNodes.push(args[0]);
              else if (method === "children") target.childNodes.push(...args[0]);
              else if (method === "when") { if (args[0]) args[1](proxy); }
              else target.attributes[method] = args;
              return proxy;
            };
          } });
          return proxy;
        }
      `,
      'resurrect-mock:gpui-base': 'export { div as h_flex, div as v_flex } from "gpui-kit";',
      'resurrect-mock:herdr': `
        const f = globalThis.resurrectModFixture;
        export const checking = () => true;
        export const spaces = () => [{ active: true, machine: "wsl" }];
        export const machines = () => [{ name: "wsl" }, { name: "coder" }];
        export const theme = () => ({});
        export const exec = async (...args) => { f.calls.push(args); return f.reply; };
      `,
    };
    if (url in modules) return { format: 'module', source: modules[url], shortCircuit: true };
    return next(url, context);
  },
});

function all(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...node.childNodes.flatMap(all)];
}
const byId = (tree, id) => all(tree).find(node => node.attributes.id?.[0] === id);

test('mod checks do not execute helpers and restore stays disabled until review', async () => {
  const { default: Mod } = await import('../../mods/resurrect/main.js');
  const cx = { notify() {}, spawn(fn) { this.work = fn(this); } };
  const view = new Mod();
  fixture.calls = [];
  view.init({}, cx);
  assert.equal(fixture.calls.length, 0);
  view.preview = { ticket: '12345678-1234-1234-1234-123456789abc', snapshotAt: 1, actions: [] };
  let tree = view.render();
  assert.equal(byId(tree, 'restore').attributes.on_click, undefined);
  byId(tree, 'reviewed').attributes.on_click[0]({}, cx);
  tree = view.render();
  assert.equal(typeof byId(tree, 'restore').attributes.on_click[0], 'function');
  fixture.reply = { code: 0, stdout: '{"started":1,"verified":false}', stderr: '' };
  byId(tree, 'restore').attributes.on_click[0]({}, cx);
  assert.equal(view.reviewed, false);
  assert.equal(view.preview, null);
  await cx.work;
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(JSON.parse(fixture.calls[0][1][2]), ['restore', '--ticket', '12345678-1234-1234-1234-123456789abc']);
  assert.equal(fixture.calls[0][2].on, 'wsl');
  assert.equal(view.report.verified, false);
});

test('failed restore reports partial progress and cannot reuse the consumed approval', async () => {
  const { default: Mod } = await import('../../mods/resurrect/main.js');
  const cx = { notify() {}, spawn(fn) { this.work = fn(this); } };
  const view = new Mod();
  view.init({}, cx);
  view.preview = { ticket: '12345678-1234-1234-1234-123456789abc', snapshotAt: 1, actions: [] };
  view.reviewed = true;
  fixture.reply = { code: 1, stdout: '', stderr: '{"error":"Session missing","resumedInPlace":1}' };
  byId(view.render(), 'restore').attributes.on_click[0]({}, cx);
  await cx.work;
  assert.equal(view.preview, null);
  assert.equal(view.reviewed, false);
  assert.match(view.error, /1 programs may already have resumed/);
});
