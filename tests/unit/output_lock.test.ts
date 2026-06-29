import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { acquireOutputLock, OutputLockError } from '../../src/runtime/output_lock';

function tempTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-output-lock-'));
  return path.join(dir, 'out.csv');
}

describe('OutputLock', () => {
  it('creates and releases a lock file', () => {
    const target = tempTarget();
    const lock = acquireOutputLock(target, { command: 'enrich' });
    expect(fs.existsSync(lock.lockPath)).toBe(true);

    lock.release();
    expect(fs.existsSync(lock.lockPath)).toBe(false);
  });

  it('rejects a second active lock on the same target', () => {
    const target = tempTarget();
    const lock = acquireOutputLock(target);

    try {
      expect(() => acquireOutputLock(target)).toThrow(OutputLockError);
    } finally {
      lock.release();
    }
  });

  it('reclaims stale locks whose pid is not alive', () => {
    const target = tempTarget();
    const lockPath = `${target}.lock`;
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, created_at: new Date().toISOString(), target }),
      'utf8'
    );

    const lock = acquireOutputLock(target);
    try {
      const payload = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) as { pid: number };
      expect(payload.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it('does not remove a lock owned by another active pid on release', () => {
    const target = tempTarget();
    const lock = acquireOutputLock(target);
    fs.writeFileSync(
      lock.lockPath,
      JSON.stringify({ pid: process.pid + 1, created_at: new Date().toISOString(), target }),
      'utf8'
    );

    lock.release();
    expect(fs.existsSync(lock.lockPath)).toBe(true);
    fs.unlinkSync(lock.lockPath);
  });
});
