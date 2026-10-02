import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPageFetcher } from '../../../src/judgment/harvest/page_fetcher';

/**
 * The harvest fetcher's POST branch (Google Places) must go through the same
 * SSRF guard as GET: a URL that reaches it from config or a redirect must never
 * dial loopback, a private network or the metadata endpoint.
 */
describe('harvest page fetcher — non-GET requests are SSRF-guarded', () => {
  let server: http.Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"secret":"internal"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses a POST to a loopback IP without connecting', async () => {
    const fetcher = buildPageFetcher(2000);
    const body = await fetcher(`http://127.0.0.1:${port}/v1/places:searchText`, { method: 'POST', body: '{}' });
    expect(body).toBeUndefined();
    expect(hits).toBe(0);
  });

  it('refuses a POST to localhost', async () => {
    const fetcher = buildPageFetcher(2000);
    expect(await fetcher(`http://localhost:${port}/`, { method: 'POST', body: '{}' })).toBeUndefined();
    expect(hits).toBe(0);
  });

  it('refuses the cloud metadata endpoint', async () => {
    const fetcher = buildPageFetcher(500);
    expect(await fetcher('http://169.254.169.254/latest/meta-data/', { method: 'POST', body: '{}' })).toBeUndefined();
  });

  it('refuses methods other than GET and POST', async () => {
    const fetcher = buildPageFetcher(500);
    expect(await fetcher('https://places.googleapis.com/v1/places:searchText', { method: 'DELETE' })).toBeUndefined();
  });
});
