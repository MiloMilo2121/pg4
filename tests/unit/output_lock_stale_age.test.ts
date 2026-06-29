/**
 * OutputLock — stale-by-age / pid-reuse guard (R13.1)
 *
 * Deterministic coverage of the reclaim policy via injected clock (`now`),
 * liveness probe (`isAlive`) and `maxAgeMs`. No real process probing, no
 * real time, no shelling — every branch is pinned exactly.
 *
 * Branches under test:
 *   1. active fresh lock (alive pid, age <= max)      → rejected
 *   2. dead pid lock (pid not alive)                  → reclaimed
 *   3. alive but old lock (alive pid, age > max)      → reclaimed (pid reuse)
 *   4. malformed lock older than max age (by mtime)   → reclaimed
 *   5. malformed lock within max age (by mtime)       → rejected
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireOutputLock, OutputLockError } from '../../src/runtime/output_lock';

const tmpDirs: string[] = [];

function tmpTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-lock-age-'));
  tmpDirs.push(dir);
  return path.join(dir, 'out.csv');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const BASE = 1_700_000_000_000; // fixed epoch ms — never Date.now()
const MAX_AGE = 1_000; // 1s window keeps the arithmetic obvious

describe('OutputLock — stale-by-age guard', () => {
  // 1. active fresh lock → rejected
  it('rejects an alive lock that is within max age', () => {
    const target = tmpTarget();
    fs.writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: 4242, created_at: new Date(BASE).toISOString(), target }),
      'utf8',
    );
    expect(() =>
      acquireOutputLock(target, {}, { now: () => BASE + 10, isAlive: () => true, maxAgeMs: MAX_AGE }),
    ).toThrow(OutputLockError);
  });

  // 2. dead pid lock → reclaimed
  it('reclaims a lock whose owner pid is not alive', () => {
    const target = tmpTarget();
    fs.writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: 4242, created_at: new Date(BASE).toISOString(), target }),
      'utf8',
    );
    const lock = acquireOutputLock(
      target,
      {},
      { now: () => BASE + 10, isAlive: () => false, maxAgeMs: MAX_AGE },
    );
    const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) as { pid: number };
    expect(payload.pid).toBe(process.pid);
    lock.release();
    expect(fs.existsSync(lock.lockPath)).toBe(false);
  });

  // 3. alive but old lock → reclaimed (the pid-reuse hazard)
  it('reclaims an alive-looking lock that is older than max age', () => {
    const target = tmpTarget();
    fs.writeFileSync(
      `${target}.lock`,
      JSON.stringify({ pid: 4242, created_at: new Date(BASE).toISOString(), target }),
      'utf8',
    );
    const lock = acquireOutputLock(
      target,
      {},
      { now: () => BASE + MAX_AGE + 1, isAlive: () => true, maxAgeMs: MAX_AGE },
    );
    const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) as { pid: number };
    expect(payload.pid).toBe(process.pid);
    lock.release();
  });

  // 4. malformed lock older than max age (by mtime) → reclaimed
  it('reclaims a malformed lock older than max age (by file mtime)', () => {
    const target = tmpTarget();
    const lockPath = `${target}.lock`;
    fs.writeFileSync(lockPath, 'not-json{{{', 'utf8');
    const mtimeMs = fs.statSync(lockPath).mtimeMs;
    const lock = acquireOutputLock(
      target,
      {},
      { now: () => mtimeMs + MAX_AGE + 1, isAlive: () => true, maxAgeMs: MAX_AGE },
    );
    const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) as { pid: number };
    expect(payload.pid).toBe(process.pid);
    lock.release();
  });

  // 5. malformed lock within max age → rejected
  it('rejects a malformed lock that is within max age (possible writer mid-creation)', () => {
    const target = tmpTarget();
    const lockPath = `${target}.lock`;
    fs.writeFileSync(lockPath, 'not-json{{{', 'utf8');
    const mtimeMs = fs.statSync(lockPath).mtimeMs;
    expect(() =>
      acquireOutputLock(target, {}, { now: () => mtimeMs + 10, isAlive: () => true, maxAgeMs: MAX_AGE }),
    ).toThrow(OutputLockError);
    // lock file is left in place (not reclaimed)
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
