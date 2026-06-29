import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { enforceRetention, resolveRetentionDays } from '../../src/compliance/retention';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-ret-'));
}

const DAY = 24 * 60 * 60 * 1000;

function makeAged(dir: string, name: string, ageDays: number, now: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x', 'utf8');
  const mtime = new Date(now - ageDays * DAY);
  fs.utimesSync(p, mtime, mtime);
  return p;
}

describe('enforceRetention — Phase D.2', () => {
  it('deletes data artifacts older than the cutoff, keeps newer ones', () => {
    const dir = tmpDir();
    const now = Date.now();
    const old = makeAged(dir, 'campaign_old.csv', 45, now);
    const oldJsonl = makeAged(dir, 'campaign_old.jsonl', 45, now);
    const fresh = makeAged(dir, 'campaign_new.csv', 5, now);

    const res = enforceRetention({ outCsv: path.join(dir, 'next.csv'), retentionDays: 30, now });
    expect(res.deleted.sort()).toEqual(['campaign_old.csv', 'campaign_old.jsonl']);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(oldJsonl)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('NEVER deletes _runs.jsonl, suppression.csv, or .lock files regardless of age', () => {
    const dir = tmpDir();
    const now = Date.now();
    const runs = makeAged(dir, '_runs.jsonl', 400, now);
    const suppr = makeAged(dir, 'suppression.csv', 400, now);
    const lock = makeAged(dir, 'campaign.csv.lock', 400, now);

    const res = enforceRetention({ outCsv: path.join(dir, 'next.csv'), retentionDays: 30, now });
    expect(res.deleted).toEqual([]);
    expect(fs.existsSync(runs)).toBe(true);
    expect(fs.existsSync(suppr)).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('ignores non-data files (e.g. .md, .txt)', () => {
    const dir = tmpDir();
    const now = Date.now();
    const note = makeAged(dir, 'notes.md', 400, now);
    enforceRetention({ outCsv: path.join(dir, 'next.csv'), retentionDays: 30, now });
    expect(fs.existsSync(note)).toBe(true);
  });
});

describe('resolveRetentionDays — Phase D.2', () => {
  it('undefined when neither flag nor env is set', () => {
    const prev = process.env.RETENTION_DAYS;
    delete process.env.RETENTION_DAYS;
    try {
      expect(resolveRetentionDays(undefined)).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.RETENTION_DAYS = prev;
    }
  });

  it('flag wins, parses to number, rejects garbage', () => {
    expect(resolveRetentionDays('30')).toBe(30);
    expect(() => resolveRetentionDays('-5')).toThrow();
    expect(() => resolveRetentionDays('soon')).toThrow();
  });
});
