import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { readJsonBody } from '../../src/server/request_body';
import { evictFinishedJobs } from '../../src/server/job_registry';
import { parseScrapeRequest } from '../../src/server/scrape_request';

const firstTarget = (body: Record<string, unknown>) => {
  const r = parseScrapeRequest(body);
  return r.ok ? r.value.targets[0] : r;
};

function request(chunks: Array<string | Buffer>, headers: Record<string, string> = {}) {
  let pulled = 0;
  const stream = new Readable({
    read() {
      const next = chunks[pulled++];
      this.push(next === undefined ? null : next);
    },
  });
  return Object.assign(stream, { headers, pulledChunks: () => pulled });
}

describe('local API — request body', () => {
  it('parses a JSON object and treats an empty body as {}', async () => {
    expect(await readJsonBody(request(['{"companyIds":', '["a"]}']))).toEqual({ ok: true, value: { companyIds: ['a'] } });
    expect(await readJsonBody(request([]))).toEqual({ ok: true, value: {} });
  });

  it('answers 400 on malformed JSON instead of running the job on an empty body', async () => {
    expect(await readJsonBody(request(['{"companyIds": ['])) ).toMatchObject({ ok: false, status: 400 });
  });

  it('answers 400 on JSON that is not an object', async () => {
    expect(await readJsonBody(request(['null']))).toMatchObject({ ok: false, status: 400 });
    expect(await readJsonBody(request(['["a"]']))).toMatchObject({ ok: false, status: 400 });
  });

  it('answers 413 from a Content-Length over 1 MB before reading anything', async () => {
    const req = request(['{}'], { 'content-length': String(1024 * 1024 + 1) });
    expect(await readJsonBody(req)).toMatchObject({ ok: false, status: 413 });
    expect(req.pulledChunks()).toBe(0);
  });

  it('answers 413 once a streamed body passes the cap and stops buffering it', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const chunks = Array.from({ length: 64 }, () => chunk); // 4 MB, no Content-Length
    const req = request(chunks);
    expect(await readJsonBody(req, 256 * 1024)).toMatchObject({ ok: false, status: 413 });
    expect(req.pulledChunks()).toBeLessThan(chunks.length);
  });

  it('counts bytes, not UTF-16 characters, against the cap', async () => {
    const body = JSON.stringify({ category: 'è'.repeat(600) }); // ~1.2 kB on the wire
    expect(await readJsonBody(request([body]), 1000)).toMatchObject({ ok: false, status: 413 });
  });
});

describe('local API — scrape arguments reach the CLI as values, never as flags', () => {
  it('keeps the existing clean-up of operator text', () => {
    expect(firstTarget({ category: '  Imprese edili; rm -rf  ', province: 'PD' })).toEqual({ category: 'Imprese edili rm -rf', province: 'PD' });
    expect(firstTarget({ category: "Sant'Angelo", province: 'PD' })).toMatchObject({ category: "Sant'Angelo" });
  });

  it('rejects a value that would be parsed as a CLI flag', () => {
    expect(parseScrapeRequest({ category: '--enable-paid', province: 'PD' })).toMatchObject({ ok: false, status: 400 });
    expect(parseScrapeRequest({ category: 'Edili', province: '--fresh' })).toMatchObject({ ok: false, status: 400 });
    expect(parseScrapeRequest({ category: '-h', province: 'PD' })).toMatchObject({ ok: false, status: 400 });
    // Clean-up strips the leading character that hid the dash.
    expect(parseScrapeRequest({ category: ' ;--enable-paid', province: 'PD' })).toMatchObject({ ok: false, status: 400 });
  });

  it('keeps 422 for a missing value and accepts a normal one', () => {
    expect(parseScrapeRequest({ category: '', province: 'PD' })).toMatchObject({ ok: false, status: 422 });
    expect(parseScrapeRequest({ province: 'PD' })).toMatchObject({ ok: false, status: 422 });
    expect(firstTarget({ category: 'Imprese edili', province: 'PD' })).toEqual({ category: 'Imprese edili', province: 'PD' });
    expect(parseScrapeRequest({ category: 'Auto-officine', province: 'PD' })).toMatchObject({ ok: true });
  });

  it('rejects a non-string value instead of stringifying it', () => {
    expect(parseScrapeRequest({ category: ['--fresh'], province: 'PD' })).toMatchObject({ ok: false });
  });
});

describe('local API — job registry eviction', () => {
  type Job = { status: 'running' | 'done' | 'error'; finishedAt?: number };
  const HOUR = 60 * 60 * 1000;

  it('drops finished jobs older than the TTL and keeps the recent ones', () => {
    const reg = new Map<string, Job>([
      ['old', { status: 'done', finishedAt: 0 }],
      ['olderr', { status: 'error', finishedAt: 10 }],
      ['recent', { status: 'done', finishedAt: 2 * HOUR - 1000 }],
    ]);
    evictFinishedJobs(reg, 2 * HOUR, { ttlMs: HOUR, maxFinished: 200 });
    expect([...reg.keys()]).toEqual(['recent']);
  });

  it('never evicts a running job, however old or however many', () => {
    const reg = new Map<string, Job>();
    for (let i = 0; i < 300; i++) reg.set(`r${i}`, { status: 'running' });
    evictFinishedJobs(reg, 100 * HOUR, { ttlMs: HOUR, maxFinished: 200 });
    expect(reg.size).toBe(300);
  });

  it('caps the finished jobs, dropping the oldest finished first', () => {
    const reg = new Map<string, Job>();
    reg.set('live', { status: 'running' });
    for (let i = 0; i < 5; i++) reg.set(`f${i}`, { status: 'done', finishedAt: 1000 - i }); // f4 finished first
    evictFinishedJobs(reg, 1000, { ttlMs: HOUR, maxFinished: 3 });
    expect([...reg.keys()].sort()).toEqual(['f0', 'f1', 'f2', 'live']);
  });

  it('treats a finished job without a timestamp as expired', () => {
    const reg = new Map<string, Job>([['legacy', { status: 'done' }]]);
    evictFinishedJobs(reg, 0, { ttlMs: HOUR, maxFinished: 200 });
    expect(reg.size).toBe(0);
  });
});
