/**
 * Access boundary for the unauthenticated local dashboard adapter.
 * Kept separate from server boot so the bind/CORS contract is unit-testable
 * and cannot drift between IPv4, IPv6, and localhost loopback forms.
 */
const LOCAL_API_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOCAL_DASHBOARD_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::1]:3000',
]);

export function resolveApiHost(value = process.env.PG4_API_HOST): string {
  const host = (value ?? '127.0.0.1').trim();
  if (!LOCAL_API_HOSTS.has(host)) {
    throw new Error(
      `PG4_API_HOST="${host}" is not allowed: the unauthenticated dev API may bind only to localhost. ` +
      'Use a local reverse proxy or add an authenticated production adapter before exposing it.',
    );
  }
  return host;
}

export function isAllowedDashboardOrigin(
  origin: string | undefined,
  extraOrigin = process.env.PG4_API_ALLOWED_ORIGIN?.trim(),
): boolean {
  return !!origin && (LOCAL_DASHBOARD_ORIGINS.has(origin) || origin === extraOrigin);
}

/**
 * Host-header gate against DNS rebinding. A rebinding page is same-origin with
 * the attacker's hostname, so its GETs carry no Origin header and pass the CORS
 * check like curl does; the only trace is a Host that is not ours. Accepts the
 * loopback names on the bound port, plus the exact host of
 * PG4_API_ALLOWED_ORIGIN for a local reverse proxy that forwards its own Host.
 */
const LOOPBACK_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/;

export function isAllowedHostHeader(
  host: string | undefined,
  port: number,
  extraOrigin = process.env.PG4_API_ALLOWED_ORIGIN?.trim(),
): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  if (extraOrigin && value === originHost(extraOrigin)) return true;
  const m = LOOPBACK_HOST_HEADER.exec(value);
  if (!m) return false;
  // A Host without a port means the scheme default; only plain http reaches this server.
  return Number(m[2] ?? 80) === port;
}

function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return undefined;
  }
}
