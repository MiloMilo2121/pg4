#!/usr/bin/env node
/*
 * Small, dependency-free persistence boundary for the VPS recovery queue.
 * Shell drivers may crash at any point; state is therefore always validated
 * before use and written temp+rename so a torn JSON file becomes an explicit
 * integrity incident instead of silently looking like an empty queue.
 */
'use strict';

// This intentionally remains a portable CommonJS Node CLI for the VPS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');

const [action, statePath, patchArg] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`recovery state integrity error: ${message}\n`);
  process.exitCode = 65;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertState(value) {
  if (!isObject(value)) throw new Error('state must be a JSON object');
  if (value.version !== 1) throw new Error('unsupported or missing state version');
  if (typeof value.cell !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.cell)) {
    throw new Error('invalid cell');
  }
  if (!['pending', 'blocked', 'complete'].includes(value.status)) throw new Error('invalid status');
  if (value.status === 'pending') {
    if (typeof value.incident_id !== 'string' || value.incident_id.length === 0) throw new Error('pending state missing incident_id');
    if (!isObject(value.envelope)) throw new Error('pending state missing envelope');
    if (!Array.isArray(value.command) || value.command.length === 0 || !value.command.every((part) => typeof part === 'string')) {
      throw new Error('pending state has invalid command');
    }
    if (!Number.isInteger(value.attempts) || value.attempts < 1) throw new Error('pending state has invalid attempts');
  }
  if (value.dispatch_status !== undefined && !['ready', 'dispatching', 'dispatched'].includes(value.dispatch_status)) {
    throw new Error('invalid dispatch_status');
  }
  for (const field of ['dispatched_attempt', 'dispatch_attempt', 'dispatch_failures']) {
    if (value[field] !== undefined && (!Number.isInteger(value[field]) || value[field] < 0)) {
      throw new Error(`invalid ${field}`);
    }
  }
}

function readState(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${filePath}: ${err.message}`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${filePath}: ${err.message}`);
  }
  assertState(value);
  return value;
}

function writeState(filePath, value) {
  assertState(value);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

try {
  if (!action || !statePath || !['read', 'write', 'patch'].includes(action)) {
    throw new Error('usage: recovery_state.js read|write|patch <state.json> [patch-json]');
  }
  if (action === 'read') {
    process.stdout.write(`${JSON.stringify(readState(statePath))}\n`);
    return;
  }
  if (action === 'write') {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try {
        writeState(statePath, JSON.parse(input));
      } catch (err) {
        fail(err.message);
      }
    });
    return;
  }
  if (!patchArg) throw new Error('patch action needs a JSON object');
  const patch = JSON.parse(patchArg);
  if (!isObject(patch) || Object.keys(patch).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
    throw new Error('invalid patch object');
  }
  const next = { ...readState(statePath), ...patch, updated_at: new Date().toISOString() };
  writeState(statePath, next);
  process.stdout.write(`${JSON.stringify(next)}\n`);
} catch (err) {
  fail(err.message);
}
