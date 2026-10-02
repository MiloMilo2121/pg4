import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../src/server/api_server';

// Dashboard judgment jobs must honour the suppression list like the CLI does
// (cli/judge.ts drops suppressed companies before judging). A suppressed
// company must be marked without touching the network.
let server: http.Server;
let port: number;
let companyId: string;
const prevSuppression = process.env.SUPPRESSION_LIST;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-judge-suppr-'));
  const seedFile = path.join(dir, 'seed.jsonl');
  fs.writeFileSync(
    seedFile,
    JSON.stringify({ company_name: 'Rossi Idraulica Srl', city: 'Padova', phone: '+39 049 9998888', official_website: 'https://example.invalid' }) + '\n',
    'utf8',
  );
  const suppressionFile = path.join(dir, 'suppression.csv');
  fs.writeFileSync(suppressionFile, 'phone,vat,email,reason,date\n+390499998888,,,operator_request,2026-09-30\n', 'utf8');
  process.env.SUPPRESSION_LIST = suppressionFile;
  server = await startApiServer({ port: 0, host: '127.0.0.1', seedFile });
  port = (server.address() as AddressInfo).port;
  const companies = (await get('/api/companies')) as unknown as { rows: Array<{ id: string }> };
  companyId = companies.rows[0].id;
});

afterAll(async () => {
  if (prevSuppression === undefined) delete process.env.SUPPRESSION_LIST;
  else process.env.SUPPRESSION_LIST = prevSuppression;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function get(p: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

function post(p: string, payload: unknown): Promise<{ status: number; body: { jobId: string } }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: p, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('dashboard judgment jobs honour the suppression list', () => {
  it('marks a suppressed company without judging it', async () => {
    const started = await post('/api/jobs/judge', { companyIds: [companyId] });
    expect(started.status).toBe(202);
    const jobId = started.body.jobId;
    let job: { status: string; items: Array<{ companyId: string; sections: Record<string, { state: string; summary?: string }> }>; [k: string]: unknown } | undefined;
    for (let i = 0; i < 100; i++) {
      const polled = (await get(`/api/jobs/${jobId}`)) as unknown as { status: string; items: Array<{ companyId: string; sections: Record<string, { state: string; summary?: string }> }>; [k: string]: unknown };
      job = polled;
      if (polled.status === 'done' || polled.status === 'error') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job).toBeDefined();
    expect(job!.status).toBe('done');
    const sections = job!.items.find((i) => i.companyId === companyId)?.sections;
    expect(sections).toBeDefined();
    for (const s of Object.values(sections!)) {
      expect(s.state).toBe('failed');
      expect(s.summary ?? '').toMatch(/suppressed/i);
    }
    // No verdict may be persisted for a company we must not contact.
    const detail = (await get(`/api/judgment?id=${companyId}`)) as unknown as { verdetto_gap: unknown };
    expect(detail.verdetto_gap).toBeNull();
  }, 30000);
});
