/**
 * Hardening audit — OutputLock
 *
 * Tests focused on:
 *   1. A second acquire on the same live target must be rejected.
 *   2. A lock file referencing a non-running pid is treated as stale and
 *      reclaimed (the existing behaviour).
 *   3. The pid-reuse caveat: `isProcessAlive` uses `process.kill(pid, 0)`,
 *      which returns truthy for any pid that the OS has recycled for an
 *      unrelated process. The created_at timestamp is stored in the lock
 *      payload but is NEVER used for secondary staleness verification.
 *      This test documents the known limitation: a reused pid causes
 *      acquireOutputLock to permanently block instead of reclaiming.
 *   4. The lock is NOT removed on release when another pid has since
 *      written to the file (guards against a race where two processes both
 *      think they own the file).
 *   5. Double release is idempotent.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { acquireOutputLock, OutputLockError } from '../../src/runtime/output_lock';

function tmpTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-hl-lock-'));
  return path.join(dir, 'out.csv');
}

describe('OutputLock — hardening', () => {
  // ------------------------------------------------------------------ //
  // 1. Mutual exclusion: second acquire on live target must throw
  // ------------------------------------------------------------------ //
  it('second acquire on same target throws OutputLockError while first lock is held', () => {
    const target = tmpTarget();
    const lock = acquireOutputLock(target, { command: 'enrich' });
    try {
      expect(() => acquireOutputLock(target)).toThrow(OutputLockError);
    } finally {
      lock.release();
    }
  });

  it('second acquire succeeds after the first lock is released', () => {
    const target = tmpTarget();
    const lock = acquireOutputLock(target);
    lock.release();
    // Lock file should be gone now
    expect(fs.existsSync(lock.lockPath)).toBe(false);
    // A new acquire should succeed
    const lock2 = acquireOutputLock(target);
    expect(fs.existsSync(lock2.lockPath)).toBe(true);
    lock2.release();
  });

  // ------------------------------------------------------------------ //
  // 2. Stale-pid reclaim: non-running pid is correctly reclaimed
  // ------------------------------------------------------------------ //
  it('reclaims a lock whose pid is clearly dead (pid=1 is init, not our process)', () => {
    // pid 1 is always the init process, not us, so process.kill(1, 0)
    // returns EPERM (the process exists but we can't signal it).
    // This means pid=1 is treated as "alive" by isProcessAlive — same as
    // a reused-pid scenario. We need a genuinely unreachable pid for the
    // stale-reclaim path. Use a large sentinel that should never be
    // a real process on any test machine.
    const target = tmpTarget();
    const lockPath = `${target}.lock`;
    // Write a fake lock with a very high pid that is almost certainly not running.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2_000_000_000, created_at: new Date().toISOString(), target }),
      'utf8',
    );
    // acquireOutputLock should remove the dead-pid lock and acquire successfully.
    const lock = acquireOutputLock(target);
    try {
      const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) as { pid: number };
      expect(payload.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  // ------------------------------------------------------------------ //
  // 3. PID-reuse guard — FIXED in R13.1
  //
  // Previously the created_at field was never consulted, so a recycled pid
  // (OS reused a dead owner's pid for an unrelated live process) pinned the
  // lock forever. acquireOutputLock now reclaims an alive-looking lock once
  // it exceeds DEFAULT_MAX_LOCK_AGE_MS (12h). This test pins the fix: a 48h
  // lock whose pid happens to be ours is reclaimed, not blocked.
  // See output_lock_stale_age.test.ts for the deterministic, injected-clock
  // coverage of every branch.
  // ------------------------------------------------------------------ //
  it('[R13.1 fix] reclaims an alive-looking lock once it exceeds max age (pid-reuse guard)', () => {
    const target = tmpTarget();
    const lockPath = `${target}.lock`;
    // pid-reuse scenario: original owner died, OS recycled its pid to THIS
    // process. The lock is ancient (48h > 12h default max age).
    const ancientDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, created_at: ancientDate, target }),
      'utf8',
    );
    const lock = acquireOutputLock(target);
    try {
      const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) as { pid: number };
      expect(payload.pid).toBe(process.pid); // reclaimed and re-acquired by us
    } finally {
      lock.release();
    }
  });

  // ------------------------------------------------------------------ //
  // 4. Race-guard: release does not delete if another pid took over
  // ------------------------------------------------------------------ //
  it('release leaves the lock file when another pid has since taken ownership', () => {
    const target = tmpTarget();
    const lock = acquireOutputLock(target);
    // Simulate another process overwriting the lock between our acquire and release.
    const alienPid = process.pid + 99_999;
    fs.writeFileSync(
      lock.lockPath,
      JSON.stringify({ pid: alienPid, created_at: new Date().toISOString(), target }),
      'utf8',
    );
    lock.release(); // should NOT delete — pid mismatch
    expect(fs.existsSync(lock.lockPath)).toBe(true);
    // Cleanup manually
    fs.unlinkSync(lock.lockPath);
  });

  // ------------------------------------------------------------------ //
  // 5. Double release is idempotent
  // ------------------------------------------------------------------ //
  it('calling release twice does not throw', () => {
    const target = tmpTarget();
    const lock = acquireOutputLock(target);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  // ------------------------------------------------------------------ //
  // 6. Lock payload contains expected fields
  // ------------------------------------------------------------------ //
  it('lock payload contains pid, created_at, target, and meta', () => {
    const target = tmpTarget();
    const lock = acquireOutputLock(target, { command: 'enrich', source: 'test' });
    try {
      const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) as {
        pid: number;
        created_at: string;
        target: string;
        meta?: Record<string, unknown>;
      };
      expect(payload.pid).toBe(process.pid);
      expect(typeof payload.created_at).toBe('string');
      expect(payload.target).toBeTruthy();
      // meta is stored at top level via spread in the payload type
      // (the acquireOutputLock signature puts meta inside the payload.meta field)
      expect(payload.meta).toBeDefined();
    } finally {
      lock.release();
    }
  });
});
