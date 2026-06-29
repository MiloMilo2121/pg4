import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { logger, bindRunLogFile, runLogPath } from '../../src/runtime/logger';

/**
 * Phase A.1 — per-run log file.
 *
 * The logger is a module singleton, so this test exercises the REAL
 * instance: bind a temp file, log a line, assert it lands as parseable
 * JSONL. Binding is first-wins, so the suite binds exactly once.
 */
describe('logger run file — Phase A.1', () => {
  it('bindRunLogFile flushes buffered lines and mirrors subsequent logs as JSONL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-log-'));
    const logPath = path.join(dir, 'run.log.jsonl');

    // Lines logged BEFORE the bind are buffered…
    logger.info({ marker: 'pre-bind-line' }, 'buffered before bind');

    const bound = bindRunLogFile(logPath);
    expect(bound).toBe(logPath);
    expect(runLogPath()).toBe(logPath);

    // …and lines after the bind stream straight through.
    logger.info({ marker: 'post-bind-line' }, 'written after bind');

    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Every line must be parseable JSON with pino's shape.
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(obj).toHaveProperty('level');
      expect(obj).toHaveProperty('time');
    }
    expect(content).toContain('pre-bind-line');
    expect(content).toContain('post-bind-line');
  });

  it('second bind is a no-op (first wins)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-log2-'));
    const other = path.join(dir, 'other.log.jsonl');
    const before = runLogPath();
    const bound = bindRunLogFile(other);
    expect(bound).toBe(before); // unchanged
    expect(fs.existsSync(other)).toBe(false);
  });
});
