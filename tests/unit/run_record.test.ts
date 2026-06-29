import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { RunRecorder, readRunHistory, runsFilePath, assessYield, EXIT, RUNS_FILENAME } from '../../src/runtime/run_record';
import type { RunRecord } from '../../src/runtime/run_record';

function tmpOut(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-runrec-'));
  return path.join(dir, 'out.csv');
}

describe('RunRecorder — Phase A.2 audit trail', () => {
  it('appends exactly one record on finish, with timestamps and exit code', () => {
    const out = tmpOut();
    const rec = new RunRecorder({ runId: 'run-test-1', command: 'scrape', outCsv: out, category: 'agenzie immobiliari' });
    rec.update({ leads_out: 42 });
    rec.finish('ok', EXIT.OK);

    const history = readRunHistory(runsFilePath(out));
    expect(history).toHaveLength(1);
    const r = history[0];
    expect(r.run_id).toBe('run-test-1');
    expect(r.command).toBe('scrape');
    expect(r.category).toBe('agenzie immobiliari');
    expect(r.leads_out).toBe(42);
    expect(r.status).toBe('ok');
    expect(r.exit_code).toBe(0);
    expect(Date.parse(r.started_at)).toBeLessThanOrEqual(Date.parse(r.finished_at!));
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('finish is a latch — second call does not append a second record', () => {
    const out = tmpOut();
    const rec = new RunRecorder({ runId: 'run-test-2', command: 'enrich', outCsv: out });
    rec.finish('interrupted', EXIT.INTERRUPTED);
    rec.finish('ok', EXIT.OK); // raced normal path — must lose
    const history = readRunHistory(runsFilePath(out));
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('interrupted');
    expect(history[0].exit_code).toBe(130);
  });

  it('records append across runs (audit file is never truncated)', () => {
    const out = tmpOut();
    new RunRecorder({ runId: 'r1', command: 'scrape', outCsv: out }).finish('ok', 0);
    new RunRecorder({ runId: 'r2', command: 'scrape', outCsv: out }).finish('fatal', 2, { error: 'boom' });
    const history = readRunHistory(runsFilePath(out));
    expect(history.map((r) => r.run_id)).toEqual(['r1', 'r2']);
    expect(history[1].error).toBe('boom');
  });

  it('runsFilePath resolves alongside the output CSV', () => {
    const out = tmpOut();
    expect(runsFilePath(out)).toBe(path.join(path.dirname(out), RUNS_FILENAME));
  });

  it('readRunHistory skips malformed lines instead of throwing', () => {
    const out = tmpOut();
    const rp = runsFilePath(out);
    fs.writeFileSync(rp, '{"record_version":1,"run_id":"good","command":"scrape","args":[],"started_at":"2026-01-01T00:00:00Z","status":"ok","exit_code":0}\nnot-json\n', 'utf8');
    const history = readRunHistory(rp);
    expect(history).toHaveLength(1);
    expect(history[0].run_id).toBe('good');
  });
});

describe('assessYield — Phase A.4 anomaly detection', () => {
  const mkRecord = (comuni: Record<string, number>, category = 'agenzie immobiliari', status: RunRecord['status'] = 'ok'): RunRecord => ({
    record_version: 1,
    run_id: `run-${Math.random()}`,
    command: 'scrape',
    args: [],
    category,
    started_at: '2026-01-01T00:00:00Z',
    status,
    exit_code: 0,
    comuni_yield: comuni,
  });

  it('no history → never suspect (first run on a province)', () => {
    const a = assessYield([], { category: 'agenzie immobiliari', comuniYield: { Padova: 3 } });
    expect(a.suspect).toBe(false);
  });

  it('flags a comune below 30% of its historical average', () => {
    const history = [mkRecord({ Padova: 200, Limena: 30 }), mkRecord({ Padova: 220, Limena: 28 })];
    const a = assessYield(history, { category: 'agenzie immobiliari', comuniYield: { Padova: 20, Limena: 29 } });
    expect(a.suspect).toBe(true);
    expect(a.suspectComuni).toEqual(['Padova']);
    expect(a.detail.Padova.historical_avg).toBe(210);
    expect(a.detail.Padova.current).toBe(20);
  });

  it('does not flag a comune at or above the threshold', () => {
    const history = [mkRecord({ Padova: 100 })];
    const a = assessYield(history, { category: 'agenzie immobiliari', comuniYield: { Padova: 30 } });
    expect(a.suspect).toBe(false);
  });

  it('ignores history from a different category', () => {
    const history = [mkRecord({ Padova: 500 }, 'ristoranti')];
    const a = assessYield(history, { category: 'agenzie immobiliari', comuniYield: { Padova: 5 } });
    expect(a.suspect).toBe(false);
  });

  it('ignores failed/interrupted runs in the baseline', () => {
    const history = [mkRecord({ Padova: 500 }, 'agenzie immobiliari', 'fatal'), mkRecord({ Padova: 500 }, 'agenzie immobiliari', 'interrupted')];
    const a = assessYield(history, { category: 'agenzie immobiliari', comuniYield: { Padova: 5 } });
    expect(a.suspect).toBe(false);
  });

  it('comuni with no history are skipped, not flagged', () => {
    const history = [mkRecord({ Padova: 100 })];
    const a = assessYield(history, { category: 'agenzie immobiliari', comuniYield: { Padova: 90, Este: 1 } });
    expect(a.suspect).toBe(false);
  });
});
