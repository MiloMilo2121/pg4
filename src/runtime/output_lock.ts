import fs from 'fs';
import path from 'path';

export class OutputLockError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, message: string) {
    super(message);
    this.name = 'OutputLockError';
    this.lockPath = lockPath;
  }
}

export interface OutputLockHandle {
  lockPath: string;
  release(): void;
}

interface LockPayload {
  pid: number;
  created_at: string;
  target: string;
  meta?: Record<string, string | number | boolean | undefined>;
}

/**
 * Default maximum age before a lock whose owner *appears* alive is treated as
 * stale and reclaimed. This guards against OS pid reuse: a long-dead enrich/
 * scrape pid can be recycled by an unrelated process, making `process.kill(pid, 0)`
 * report "alive" forever and pinning the lock. 12h comfortably exceeds the
 * longest legitimate run while still self-healing within a day.
 */
export const DEFAULT_MAX_LOCK_AGE_MS = 12 * 60 * 60 * 1000;

export interface AcquireOutputLockOptions {
  /** Max age (ms) after which an alive-looking lock is reclaimed as stale. */
  maxAgeMs?: number;
  /** Clock injection point (ms epoch). Defaults to Date.now. */
  now?: () => number;
  /** Liveness check injection point. Defaults to a `kill(pid, 0)` probe. */
  isAlive?: (pid: number) => boolean;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function readLock(lockPath: string): LockPayload | undefined {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockPayload;
  } catch {
    return undefined;
  }
}

/** Age of the lock file on disk via mtime; Infinity if it cannot be stat'd. */
function mtimeAgeMs(lockPath: string, nowMs: number): number {
  try {
    return nowMs - fs.statSync(lockPath).mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Age of a valid lock: prefer the recorded `created_at`, fall back to the file
 * mtime when the timestamp is missing or unparseable.
 */
function lockAgeMs(payload: LockPayload, lockPath: string, nowMs: number): number {
  const created = payload.created_at ? Date.parse(payload.created_at) : NaN;
  if (!Number.isNaN(created)) return nowMs - created;
  return mtimeAgeMs(lockPath, nowMs);
}

/**
 * Atomic file lock for long-running CLI outputs.
 *
 * This prevents two enrich/scrape processes from writing the same CSV,
 * JSONL and cost ledger concurrently. A sandboxed `tsx` launch can fail
 * while leaving its child process alive; without this lock a retry may
 * corrupt the output and double-spend paid providers.
 *
 * Reclaim policy when the lock already exists:
 *  - owner pid is gone            → reclaim (dead owner).
 *  - owner pid alive, age > max   → reclaim (assumed pid reuse / stale).
 *  - owner pid alive, age <= max  → reject (genuine active run).
 *  - lock unreadable/malformed    → reclaim only if file mtime > max age,
 *                                   otherwise reject (could be a fresh writer
 *                                   mid-creation).
 */
export function acquireOutputLock(
  targetPath: string,
  meta: Record<string, string | number | boolean | undefined> = {},
  opts: AcquireOutputLockOptions = {}
): OutputLockHandle {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_LOCK_AGE_MS;
  const now = opts.now ?? Date.now;
  const isAlive = opts.isAlive ?? isProcessAlive;

  const lockPath = `${targetPath}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const payload: LockPayload = {
    pid: process.pid,
    created_at: new Date(now()).toISOString(),
    target: path.resolve(targetPath),
    meta,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      fs.closeSync(fd);
      let released = false;
      return {
        lockPath,
        release() {
          if (released) return;
          released = true;
          try {
            const current = readLock(lockPath);
            if (!current || current.pid === process.pid) fs.unlinkSync(lockPath);
          } catch {
            // Best effort cleanup. A missing lock is already released.
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      const existing = readLock(lockPath);

      // Unreadable / malformed lock: reclaim only if it is older than maxAge
      // (by file mtime). A very recent malformed lock may be a writer that is
      // still mid-creation, so we reject rather than race it.
      if (!existing) {
        const age = mtimeAgeMs(lockPath, now());
        if (age > maxAgeMs) {
          console.warn(
            `[output-lock] stale lock reclaimed by age: malformed/unreadable lock ${lockPath} is ${Math.round(age)}ms old (> ${maxAgeMs}ms)`
          );
          fs.unlinkSync(lockPath);
          continue;
        }
        throw new OutputLockError(
          lockPath,
          `Output is locked by an unreadable lock file (${lockPath}) that is too recent to reclaim safely. ` +
            `If no scrape/enrich process is active, remove it manually after confirming with: ps -p <pid> -o command.`
        );
      }

      // Owner process is gone → safe to reclaim regardless of age.
      if (!isAlive(existing.pid)) {
        fs.unlinkSync(lockPath);
        continue;
      }

      // Owner pid appears alive. Guard against OS pid reuse: if the lock is
      // older than maxAge, the original owner almost certainly exited and this
      // pid was recycled — reclaim it.
      const age = lockAgeMs(existing, lockPath, now());
      if (age > maxAgeMs) {
        console.warn(
          `[output-lock] stale lock reclaimed by age: ${lockPath} is ${Math.round(age)}ms old (> ${maxAgeMs}ms); ` +
            `pid ${existing.pid} appears alive but is assumed recycled (OS pid reuse)`
        );
        fs.unlinkSync(lockPath);
        continue;
      }

      // Alive and within max age → genuine active owner.
      throw new OutputLockError(
        lockPath,
        `Output is already locked by pid ${existing.pid}: ${lockPath}. Wait for the running process to finish, ` +
          `or remove the lock only after confirming no matching process is active (ps -p ${existing.pid} -o command).`
      );
    }
  }

  throw new OutputLockError(lockPath, `Could not acquire output lock: ${lockPath}`);
}
