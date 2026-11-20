'use strict';

const MAX_NODES = 4096;
const MAX_DEPTH = 32;

function validateLayout(document) {
  if (!document || !Array.isArray(document.spaces)) {
    throw new Error('Unsupported Herdr document: expected spaces.');
  }
  const ids = new Set();
  const terminals = new Set();
  let count = 0;
  function identify(value) {
    if (!value || typeof value.id !== 'string' || !value.id || ids.has(value.id)) {
      throw new Error('Missing or duplicate layout identity.');
    }
    ids.add(value.id);
  }
  function visit(node, depth) {
    if (++count > MAX_NODES || depth > MAX_DEPTH) throw new Error('Layout is too large.');
    identify(node);
    if (node.type === 'row' || node.type === 'column') {
      if (!Array.isArray(node.children) || !node.children.length) {
        throw new Error('A split must contain children.');
      }
      for (const child of node.children) visit(child, depth + 1);
    } else if (node.type === 'block') {
      if (typeof node.content?.terminal !== 'string' || !node.content.terminal) {
        throw new Error('This adapter supports terminal blocks only.');
      }
      if (terminals.has(node.content.terminal)) throw new Error('Duplicate terminal reference.');
      terminals.add(node.content.terminal);
    } else {
      throw new Error(`Unsupported layout node: ${node.type}`);
    }
    if (node.size !== undefined) {
      const size = node.size;
      const keys = size && Object.keys(size);
      if (!keys || keys.length !== 1 || !['px', 'weight'].includes(keys[0])
        || !Number.isFinite(size[keys[0]]) || size[keys[0]] <= 0) {
        throw new Error('Invalid split size.');
      }
    }
  }
  for (const space of document.spaces) {
    identify(space);
    if (!Array.isArray(space.tabs)) throw new Error('Unsupported tab collection.');
    for (const tab of space.tabs) {
      identify(tab);
      visit(tab.root, 0);
    }
  }
  return [...terminals];
}

function remapLayout(document, replacements) {
  const references = validateLayout(document);
  const targets = new Set();
  for (const source of references) {
    const target = replacements[source];
    if (typeof target !== 'string' || !target || targets.has(target)) {
      throw new Error(`Missing or duplicate replacement for ${source}.`);
    }
    targets.add(target);
  }
  const copy = structuredClone(document);
  function visit(node) {
    if (node.type === 'block') node.content.terminal = replacements[node.content.terminal];
    else node.children.forEach(visit);
  }
  for (const space of copy.spaces) for (const tab of space.tabs) visit(tab.root);
  return copy;
}

module.exports = { validateLayout, remapLayout };
