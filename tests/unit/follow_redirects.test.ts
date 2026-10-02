import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { followRedirects } from '../../src/providers/http/follow_redirects';

/**
 * undici removed `maxRedirections` in v7. Passing it now throws
 * `maxRedirections is not supported, use the redirect interceptor` — and that
 * throw lands in the caller's `catch`, where it is indistinguishable from a
 * network blip. Four providers were passing it.
 *
 * These tests run against a real local server because the thing being verified
 * is undici's own redirect/status handling; a mock would assert the mock.
 */
interface Hop {
  method: string;
  url: string;
  body: string;
}

let server: http.Server;
let origin: string;
const hops: Hop[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hops.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString() });
      const url = req.url ?? '/';

      if (url === '/start') return void res.writeHead(301, { location: '/end' }).end();
      if (url === '/end') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>arrived</html>');

      // Method-preserving redirects, to pin the 307/308 branch.
      if (url === '/keep-method') return void res.writeHead(307, { location: '/echo' }).end();
      if (url === '/downgrade') return void res.writeHead(303, { location: '/echo' }).end();
      if (url === '/echo') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(`${req.method}:${Buffer.concat(chunks).toString()}`);

      // A cycle: every hop points back, so only the hop cap can stop it.
      if (url === '/loop-a') return void res.writeHead(302, { location: '/loop-b' }).end();
      if (url === '/loop-b') return void res.writeHead(302, { location: '/loop-a' }).end();

      // Unparseable Location must surface as-is rather than throw.
      if (url === '/bad-location') return void res.writeHead(302, { location: 'http://[bad' }).end();

      // Non-web schemes. `new URL()` resolves both of these without complaint,
      // so only an explicit allowlist stops us fetching them.
      if (url === '/to-file') return void res.writeHead(302, { location: 'file:///etc/passwd' }).end();
      if (url === '/to-js') return void res.writeHead(302, { location: 'javascript:alert(1)' }).end();

      // A cross-origin hop, so the guard has something to object to.
      if (url === '/cross-origin') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();

      res.writeHead(404).end('nope');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('followRedirects', () => {
  it('follows a 301 to the final page and reports where it landed', async () => {
    const { response, finalUrl } = await followRedirects(`${origin}/start`);

    expect(response.statusCode).toBe(200);
    expect(await response.body.text()).toBe('<html>arrived</html>');
    expect(finalUrl).toBe(`${origin}/end`);
  });

  it('preserves the method and body across a 307', async () => {
    const { response } = await followRedirects(`${origin}/keep-method`, {
      method: 'POST',
      body: 'payload=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(await response.body.text()).toBe('POST:payload=1');
  });

  it('downgrades a 303 to GET and drops the body, the way a browser does', async () => {
    const { response } = await followRedirects(`${origin}/downgrade`, {
      method: 'POST',
      body: 'payload=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(await response.body.text()).toBe('GET:');
  });

  it('gives up on a redirect cycle instead of spinning until the timeout', async () => {
    const before = hops.length;
    const { response } = await followRedirects(`${origin}/loop-a`);

    // It stops on a 3xx rather than exhausting the caller's whole time budget.
    expect(response.statusCode).toBe(302);
    // 1 initial + 5 capped hops. The cap is what makes this terminate.
    expect(hops.length - before).toBe(6);
  }, 10_000);

  it('surfaces an unparseable Location as the 3xx it is', async () => {
    const { response } = await followRedirects(`${origin}/bad-location`);

    expect(response.statusCode).toBe(302);
  });

  it.each([
    ['file:///etc/passwd', '/to-file'],
    ['javascript:alert(1)', '/to-js'],
  ])('refuses to follow a %s redirect', async (_label, path) => {
    // `new URL('file:///etc/passwd', base)` resolves without throwing, so
    // nothing about parsing stops us. Only the scheme allowlist does.
    const { response, finalUrl } = await followRedirects(`${origin}${path}`);

    expect(response.statusCode).toBe(302);
    expect(finalUrl).toBe(`${origin}${path}`);
  });

  it('runs the guard on every hop, not just the entry URL', async () => {
    const seen: string[] = [];
    await expect(
      followRedirects(`${origin}/cross-origin`, {
        assertHop: (u) => {
          seen.push(u);
          if (!u.startsWith(origin)) throw new Error(`blocked: ${u}`);
        },
      }),
    ).rejects.toThrow('blocked');

    // The guard saw the metadata address — it was not skipped because the
    // caller only checked the URL it passed in.
    expect(seen).toEqual([
      `${origin}/cross-origin`,
      'http://169.254.169.254/latest/meta-data/',
    ]);
  });

  it('lets a same-origin redirect through an origin-scoped guard', async () => {
    // The guard is the caller's SSRF policy. It must be consulted on every
    // hop, and it must not fire on hops the policy allows.
    const { response } = await followRedirects(`${origin}/start`, {
      assertHop: (u) => {
        if (!u.startsWith(origin)) throw new Error(`blocked: ${u}`);
      },
    });

    expect(response.statusCode).toBe(200);
  });
});
