'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, privateDirectory } = require('./store');

function defaultConfigFile() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'herdr-resurrect', 'config.json');
}

function readConfig(file = defaultConfigFile()) {
  const value = readJson(file);
  return validateConfig(value);
}

function validateConfig(value) {
  if (!value || value.version !== 1) throw new Error('Install or configure the native host recorder first.');
  const fields = new Set(['version', 'stateDir', 'hc', 'intervalMs', 'opencodeStateDir',
    'claudeConfigDir', 'session', 'socket', 'installDir']);
  if (Object.keys(value).some(key => !fields.has(key))) throw new Error('Unknown recorder configuration field.');
  for (const key of ['stateDir', 'hc', 'opencodeStateDir', 'claudeConfigDir']) {
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key]) || /[\0\r\n]/.test(value[key])) {
      throw new Error(`Configuration needs an absolute ${key} path.`);
    }
  }
  if (value.socket !== undefined && (typeof value.socket !== 'string'
    || !path.isAbsolute(value.socket) || /[\0\r\n]/.test(value.socket))) throw new Error('Invalid core socket override.');
  if (value.installDir !== undefined && (typeof value.installDir !== 'string'
    || !path.isAbsolute(value.installDir) || /[\0\r\n]/.test(value.installDir))) throw new Error('Invalid package installation directory.');
  if (!Number.isInteger(value.intervalMs) || value.intervalMs < 1000 || value.intervalMs > 86400000) {
    throw new Error('Capture interval must be between one second and one day.');
  }
  if (typeof value.session !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(value.session)) {
    throw new Error('Invalid core session name.');
  }
  return value;
}

function hostOptions(config) {
  privateDirectory(config.stateDir);
  const hostFile = path.join(config.stateDir, 'host-id');
  try { fs.writeFileSync(hostFile, randomUUID() + '\n', { flag: 'wx', mode: 0o600 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(hostFile);
  if (!stat.isFile() || stat.isSymbolicLink()
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('Invalid host identity file.');
  }
  const host = fs.readFileSync(hostFile, 'utf8').trim();
  if (!/^[a-f0-9-]{36}$/.test(host)) throw new Error('Invalid host identity.');
  return {
    host, boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    opencodeStateDir: config.opencodeStateDir, claudeConfigDir: config.claudeConfigDir,
  };
}

function coreEnv(config, env = process.env) {
  const result = { ...env, HC_SESSION: config.session };
  for (const key of ['HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'HC_SOCKET']) delete result[key];
  if (config.socket) result.HC_SOCKET = config.socket;
  return result;
}

function executable(name, env = process.env) {
  const candidates = path.isAbsolute(name) ? [name]
    : (env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error(`Required program is unavailable: ${path.basename(name)}`);
}

module.exports = { defaultConfigFile, readConfig, validateConfig, hostOptions, coreEnv, executable };
