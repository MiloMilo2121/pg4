import fs from 'fs';
import path from 'path';
import pino from 'pino';
import pretty from 'pino-pretty';

const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
const format = (process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty')).toLowerCase();

/**
 * Phase A.1 — persistent per-run log file.
 *
 * Every CLI run mirrors its full structured log (JSONL, one pino line per
 * event) to a file alongside the outputs, so a crashed overnight run leaves
 * forensic evidence even when the operator forgot to `tee`.
 *
 * Resolution order for the file path:
 *   1. `LOG_FILE=off|0|false`  → file logging disabled.
 *   2. `LOG_FILE=<path>`       → exact path, bound at module init.
 *   3. neither                 → the CLI calls `bindRunLogFile(<out>.log.jsonl)`
 *                                after parsing args; lines logged before the
 *                                bind are buffered (bounded) and flushed on bind.
 *
 * The stream is a plain object with a `write(line)` method — pino.multistream
 * accepts it directly. Writes are synchronous appends: at pg4's log volume
 * (hundreds of lines per run) this costs nothing and survives `process.exit`.
 */
class RunFileStream {
  private fd: number | null = null;
  private buffer: string[] = [];
  private disabled = false;
  private boundPath: string | null = null;
  /** Cap the pre-bind buffer so a pathological no-bind run can't grow unbounded. */
  private static readonly MAX_BUFFER = 2000;

  write(line: string): void {
    if (this.disabled) return;
    if (this.fd !== null) {
      try {
        fs.writeSync(this.fd, line);
      } catch {
        // Disk hiccup: drop the line rather than crash the pipeline.
      }
      return;
    }
    if (this.buffer.length < RunFileStream.MAX_BUFFER) this.buffer.push(line);
  }

  bind(filePath: string): void {
    if (this.disabled || this.fd !== null) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.fd = fs.openSync(filePath, 'w');
      this.boundPath = filePath;
      for (const line of this.buffer) fs.writeSync(this.fd, line);
      this.buffer = [];
    } catch {
      // Could not open the log file (permissions, missing dir on a read-only
      // mount, …): disable file logging instead of breaking the run.
      this.disabled = true;
      this.buffer = [];
    }
  }

  disable(): void {
    this.disabled = true;
    this.buffer = [];
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
  }

  currentPath(): string | null {
    return this.boundPath;
  }
}

const runFileStream = new RunFileStream();

const envLogFile = process.env.LOG_FILE;
if (envLogFile !== undefined) {
  const v = envLogFile.trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === '') {
    runFileStream.disable();
  } else {
    runFileStream.bind(envLogFile);
  }
}

const consoleStream: pino.DestinationStream =
  format === 'pretty'
    ? pretty({ colorize: true, ignore: 'pid,hostname', translateTime: 'HH:MM:ss.l' })
    : pino.destination(1);

export const logger = pino(
  {
    level,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { stream: consoleStream, level: level as pino.Level },
    { stream: runFileStream, level: level as pino.Level },
  ])
);

/**
 * Bind the per-run log file. Called by CLI entry points once the output
 * path is known. No-op when LOG_FILE env already bound/disabled the stream
 * or when a previous bind happened (first bind wins).
 * Returns the active log file path, or null when file logging is off.
 */
export function bindRunLogFile(filePath: string): string | null {
  runFileStream.bind(filePath);
  return runFileStream.currentPath();
}

/** Active run-log path (null when disabled or not yet bound). */
export function runLogPath(): string | null {
  return runFileStream.currentPath();
}

/** Create a child logger with a stable bound context (e.g. `{ stage: 'rdap' }`). */
export function child(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
