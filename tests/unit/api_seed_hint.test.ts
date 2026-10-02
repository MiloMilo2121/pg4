import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../src/server/api_server';

/**
 * Fase 5.5 — un seed vuoto (file assente o senza righe) non deve più dare una
 * dashboard muta: /api/health espone seedEmpty + seedHint che rimanda a
 * `pnpm demo`, e la dashboard mostra un banner.
 */
let server: http.Server;
let port: number;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-seedhint-'));
  server = await startApiServer({
    port: 0,
    host: '127.0.0.1',
    seedFile: path.join(dir, 'does-not-exist.jsonl'),
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function get(pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: pathname, headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('empty seed surfaces a dashboard hint', () => {
  it('/api/health reports seedEmpty + a pnpm demo hint when nothing loaded', async () => {
    const r = await get('/api/health');
    expect(r.status).toBe(200);
    const health = JSON.parse(r.body) as { companies: number; seedEmpty: boolean; seedHint?: string };
    expect(health.companies).toBe(0);
    expect(health.seedEmpty).toBe(true);
    expect(health.seedHint).toMatch(/pnpm demo/);
  });
});
