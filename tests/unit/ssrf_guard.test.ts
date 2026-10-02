import http from 'http';
import type { AddressInfo } from 'net';
import { Agent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DirectFetchProvider } from '../../src/providers/http/direct_fetch';
import { assertPublicLiteralHost, BlockedDestinationError, guardedLookup, isNonPublicAddress } from '../../src/providers/http/ssrf_guard';

describe('isNonPublicAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])(
    'blocks %s',
    (ip) => expect(isNonPublicAddress(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '151.101.1.69', '2a00:1450:4002::66', '::ffff:8.8.8.8'])('allows %s', (ip) => expect(isNonPublicAddress(ip)).toBe(false));
});

describe('assertPublicLiteralHost', () => {
  it('rejects IP-literal and localhost URLs pointing inside', () => {
    for (const u of ['http://127.0.0.1:8787/api', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost/', 'http://api.localhost/']) {
      expect(() => assertPublicLiteralHost(u)).toThrow(BlockedDestinationError);
    }
  });
  it('lets public hosts through (they are checked again at connect time)', () => {
    expect(() => assertPublicLiteralHost('https://www.example.it/contatti')).not.toThrow();
    expect(() => assertPublicLiteralHost('http://8.8.8.8/')).not.toThrow();
  });
});

describe('guardedLookup', () => {
  const fakeResolve = (map: Record<string, string>) =>
    ((host: string, _opts: unknown, cb: (e: Error | null, a?: unknown) => void) =>
      cb(null, [{ address: map[host] ?? '93.184.216.34', family: 4 }])) as unknown as Parameters<typeof guardedLookup>[0];

  it('fails the connection when a hostname resolves to a private address', async () => {
    const lookup = guardedLookup(fakeResolve({ 'evil.example': '10.0.0.7' }));
    const err = await new Promise<Error | null>((res) => lookup('evil.example', {}, (e: NodeJS.ErrnoException | null) => res(e)));
    expect(err).toBeInstanceOf(BlockedDestinationError);
  });

  it('returns the address for public hostnames (single and `all` forms)', async () => {
    const lookup = guardedLookup(fakeResolve({}));
    const one = await new Promise<unknown>((res) => lookup('ok.example', {}, (_e: unknown, a: unknown) => res(a)));
    expect(one).toBe('93.184.216.34');
    const all = await new Promise<unknown>((res) => lookup('ok.example', { all: true }, (_e: unknown, a: unknown) => res(a)));
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('DirectFetchProvider — SSRF + body cap (local server)', () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/huge') {
        res.writeHead(200, { 'content-type': 'text/html' }); // chunked, no content-length
        const chunk = Buffer.alloc(1_000_000, 'a');
        for (let i = 0; i < 11; i++) res.write(chunk);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>secret internal page</html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('refuses to fetch a loopback URL by default', async () => {
    const res = await new DirectFetchProvider().fetch(`http://127.0.0.1:${port}/`);
    expect(res.html).toBeUndefined();
    expect(res.error).toMatch(/blocked non-public destination/);
  });

  it('refuses a public-looking hostname that resolves inside (DNS rebinding shape)', async () => {
    const lookup = guardedLookup(((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as Parameters<typeof guardedLookup>[0]);
    const fetcher = new DirectFetchProvider({ dispatcher: new Agent({ connect: { lookup } }) });
    const res = await fetcher.fetch(`http://innocent.example:${port}/`);
    expect(res.html).toBeUndefined();
    expect(res.error).toMatch(/blocked non-public destination/);
  });

  it('fetches normally when private networks are explicitly allowed (tests only)', async () => {
    const res = await new DirectFetchProvider({ allowPrivateNetwork: true }).fetch(`http://127.0.0.1:${port}/`);
    expect(res.html).toContain('secret internal page');
  });

  it('caps an undeclared-size body instead of buffering it all', async () => {
    const res = await new DirectFetchProvider({ allowPrivateNetwork: true }).fetch(`http://127.0.0.1:${port}/huge`);
    expect(res.html).toBeUndefined();
    expect(res.error).toMatch(/body too large/);
  });
});

describe('SMTP dialer — never dials a non-public MX', () => {
  it('rejects an IP-literal private MX before connecting', async () => {
    const { defaultDialer } = await import('../../src/enrichment/email/mx_smtp_verifier.js');
    await expect(defaultDialer('127.0.0.1', { port: 25, timeoutMs: 1000 })).rejects.toBeInstanceOf(BlockedDestinationError);
  });
});
