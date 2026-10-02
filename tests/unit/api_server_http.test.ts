import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../src/server/api_server';

// The real handler on an ephemeral loopback port, seeded from a temp file.
// No request here may reach a job runner that touches the network: every job
// POST below is one the guards must refuse.
let server: http.Server;
let port: number;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-api-'));
  const seedFile = path.join(dir, 'seed.jsonl');
  fs.writeFileSync(seedFile, JSON.stringify({ company_name: 'Alfa Srl', city: 'Padova', phone: '0491111111' }) + '\n', 'utf8');
  server = await startApiServer({ port: 0, host: '127.0.0.1', seedFile });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function call(opts: { method?: string; path: string; host?: string; body?: string | Buffer; headers?: Record<string, string> }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    // The server may answer 413 and close before the upload finishes.
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('local API over HTTP — Host header', () => {
  it('serves loopback Hosts on the bound port', async () => {
    expect((await call({ path: '/api/health' })).status).toBe(200);
    expect((await call({ path: '/api/health', host: `localhost:${port}` })).status).toBe(200);
  });

  it('refuses a DNS-rebinding Host with 403, before any data is read', async () => {
    const r = await call({ path: '/api/companies', host: `attacker.example:${port}` });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'host not allowed' });
  });
});

describe('local API over HTTP — /api/health', () => {
  it('answers HEAD without a body and refuses other methods with 405', async () => {
    const head = await call({ method: 'HEAD', path: '/api/health' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    const post = await call({ method: 'POST', path: '/api/health', body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });
});

describe('local API over HTTP — request bodies', () => {
  it('answers 413 to a body over 1 MB', async () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 0x20);
    const r = await call({ method: 'POST', path: '/api/jobs/enrich', body: big, headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(413);
  });

  it('answers 400 to malformed JSON', async () => {
    const r = await call({ method: 'POST', path: '/api/jobs/judge', body: '{"companyIds": [' });
    expect(r.status).toBe(400);
  });

  it('answers 400 to a scrape value that would become a CLI flag', async () => {
    const r = await call({ method: 'POST', path: '/api/jobs/scrape', body: JSON.stringify({ category: '--enable-paid', province: 'PD' }) });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/must not start with "-"/);
  });
});

describe('local API over HTTP — dashboard jobs', () => {
  it('refuses a wizard source the scrape CLI cannot run, with the reason', async () => {
    const body = JSON.stringify({ categories: ['Fabbri'], provinces: ['Padova'], sources: ['pg', 'oa'] });
    const r = await call({ method: 'POST', path: '/api/jobs/scrape', body });
    expect(r.status).toBe(422);
    expect(JSON.parse(r.body).error).toMatch(/^oa: paid sources/);
  });

  it('refuses a flag-like value inside the wizard lists', async () => {
    const body = JSON.stringify({ categories: ['Fabbri'], provinces: ['PD', '--fresh'], sources: ['pg'] });
    expect((await call({ method: 'POST', path: '/api/jobs/scrape', body })).status).toBe(400);
  });
});

describe('local API over HTTP — /api/cost', () => {
  it('reports an unmeasured seed cost as null, not 0, and the live session from the jobs', async () => {
    const cost = JSON.parse((await call({ path: '/api/cost' })).body);
    expect(cost.seedRunCostEur).toBeNull();
    expect(cost.liveSessionCostEur).toBe(0);
    expect(cost.liveSessionBreakdown).toEqual({ enrichEur: 0, judgmentEur: 0, scrapeEur: 0 });
    const runs = JSON.parse((await call({ path: '/api/runs' })).body);
    if (runs.source === 'seed') expect(runs.runs[0].total_cost_eur).toBeNull();
  });
});
