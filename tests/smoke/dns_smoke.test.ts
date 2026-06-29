import { describe, it, expect } from 'vitest';
import { request } from 'undici';

const ENABLED = process.env.RUN_SMOKE === '1' || process.env.RUN_SMOKE === 'true';

describe.runIf(ENABLED)('smoke: real network', () => {
  it('crt.sh returns JSON for a known domain', async () => {
    const res = await request('https://crt.sh/?q=example.com&output=json', { bodyTimeout: 15000, headersTimeout: 15000 });
    expect(res.statusCode).toBe(200);
    const body = await res.body.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('DDG-lite responds 200', async () => {
    const res = await request('https://lite.duckduckgo.com/lite/?q=test', { bodyTimeout: 15000, headersTimeout: 15000 });
    expect([200, 202]).toContain(res.statusCode);
    await res.body.text();
  });
});

describe.skipIf(ENABLED)('smoke: skipped (RUN_SMOKE not set)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
});
