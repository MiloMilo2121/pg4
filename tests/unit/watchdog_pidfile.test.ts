import { execFileSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * scripts/lib/pidfile.sh — the watchdog's campaign liveness check. A bare
 * `kill -0 $pid` trusted a recycled PID after sleep/reboot and the campaign
 * was never relaunched.
 */
const LIB = path.resolve('scripts/lib/pidfile.sh');
let dir: string;
let child: ChildProcess;

function alive(file: string, expect: string): boolean {
  try {
    execFileSync('bash', ['-c', `. "${LIB}"; pidfile_alive "$0" "$1"`, file, expect]);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-pidfile-'));
  child = spawn('sleep', ['30'], { stdio: 'ignore' });
});
afterAll(() => {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pidfile_alive', () => {
  it('true for the recorded live process running the expected command', () => {
    const f = path.join(dir, 'ok.pid');
    execFileSync('bash', ['-c', `. "${LIB}"; pidfile_write "$0" "$1"`, f, String(child.pid)]);
    expect(alive(f, 'sleep')).toBe(true);
  });

  it('false when the PID was recycled (same PID, different start time)', () => {
    const f = path.join(dir, 'reused.pid');
    fs.writeFileSync(f, `${child.pid}\tMon Jan  1 00:00:00 2001\n`);
    expect(alive(f, 'sleep')).toBe(false);
  });

  it('false when the PID runs a different command', () => {
    const f = path.join(dir, 'other.pid');
    execFileSync('bash', ['-c', `. "${LIB}"; pidfile_write "$0" "$1"`, f, String(child.pid)]);
    expect(alive(f, 'scripts/campaign.sh')).toBe(false);
  });

  it('false for a dead PID and a missing file', () => {
    const dead = path.join(dir, 'dead.pid');
    fs.writeFileSync(dead, '999999\tMon Jan  1 00:00:00 2001\n');
    expect(alive(dead, 'sleep')).toBe(false);
    expect(alive(path.join(dir, 'missing.pid'), 'sleep')).toBe(false);
  });

  it('a legacy bare-PID file (pre-upgrade watchdog) is judged on liveness + command, never blindly relaunched', () => {
    const legacy = path.join(dir, 'legacy.pid');
    fs.writeFileSync(legacy, `${child.pid}\n`);
    expect(alive(legacy, 'sleep')).toBe(true);
    expect(alive(legacy, 'scripts/campaign.sh')).toBe(false);
  });
});
