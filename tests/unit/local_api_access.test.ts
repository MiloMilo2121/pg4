import { describe, expect, it } from 'vitest';
import { isAllowedDashboardOrigin, resolveApiHost } from '../../src/server/local_api_access';

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
