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
