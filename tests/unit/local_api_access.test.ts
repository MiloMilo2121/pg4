import { describe, expect, it } from 'vitest';
import { isAllowedDashboardOrigin, isAllowedHostHeader, resolveApiHost } from '../../src/server/local_api_access';

describe('local dashboard API access boundary', () => {
  it('allows every loopback bind form but refuses LAN/public binds', () => {
    expect(resolveApiHost('127.0.0.1')).toBe('127.0.0.1');
    expect(resolveApiHost('localhost')).toBe('localhost');
    expect(resolveApiHost('::1')).toBe('::1');
    expect(() => resolveApiHost('0.0.0.0')).toThrow('unauthenticated dev API');
  });

  it('keeps CORS aligned with IPv4, IPv6, and localhost dashboard origins', () => {
    expect(isAllowedDashboardOrigin('http://localhost:3000', undefined)).toBe(true);
    expect(isAllowedDashboardOrigin('http://127.0.0.1:3000', undefined)).toBe(true);
    expect(isAllowedDashboardOrigin('http://[::1]:3000', undefined)).toBe(true);
    expect(isAllowedDashboardOrigin('http://192.168.1.2:3000', undefined)).toBe(false);
  });
});

describe('local dashboard API — Host header (DNS rebinding)', () => {
  it('accepts the loopback names on the bound port, as the dashboard and curl send them', () => {
    expect(isAllowedHostHeader('localhost:8787', 8787, undefined)).toBe(true);
    expect(isAllowedHostHeader('127.0.0.1:8787', 8787, undefined)).toBe(true);
    expect(isAllowedHostHeader('[::1]:8787', 8787, undefined)).toBe(true);
    expect(isAllowedHostHeader('LOCALHOST:8787', 8787, undefined)).toBe(true);
  });

  it('refuses a rebound attacker hostname, even when it resolves to loopback', () => {
    expect(isAllowedHostHeader('attacker.example:8787', 8787, undefined)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1.nip.io:8787', 8787, undefined)).toBe(false);
    expect(isAllowedHostHeader('evil@127.0.0.1:8787', 8787, undefined)).toBe(false);
    expect(isAllowedHostHeader('localhost.:8787', 8787, undefined)).toBe(false);
  });

  it('refuses a missing Host and a port other than the bound one', () => {
    expect(isAllowedHostHeader(undefined, 8787, undefined)).toBe(false);
    expect(isAllowedHostHeader('', 8787, undefined)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1:9999', 8787, undefined)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1', 8787, undefined)).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1', 80, undefined)).toBe(true);
  });

  it('accepts the exact host of PG4_API_ALLOWED_ORIGIN for a local reverse proxy', () => {
    expect(isAllowedHostHeader('dash.lan:8443', 8787, 'https://dash.lan:8443')).toBe(true);
    expect(isAllowedHostHeader('dash.lan', 8787, 'https://dash.lan:8443')).toBe(false);
    expect(isAllowedHostHeader('dash.lan:8443', 8787, 'not a url')).toBe(false);
  });
});
