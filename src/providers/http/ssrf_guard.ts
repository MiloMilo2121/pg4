import dns from 'dns';
import net from 'net';
import { Agent } from 'undici';

/**
 * SSRF guard for fetches whose URLs come from scraped data. A listing (or a
 * redirect) pointing at `localhost`, a private network or the cloud metadata
 * endpoint (169.254.169.254) must never be fetched from the machine running a
 * campaign — on a VPS that is a credential leak.
 *
 * Enforced at CONNECT time: the dispatcher's DNS lookup rejects any resolved
 * address in a non-public range, so every hop (redirects included) is checked
 * against the address actually dialled — no resolve-then-connect gap for DNS
 * rebinding. IP-literal hosts skip DNS, so they are checked up front too.
 */

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  BLOCKED.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(addr, prefix, 'ipv6');
}

/** True for loopback / private / link-local / reserved addresses (IPv4, IPv6, IPv4-mapped IPv6). */
export function isNonPublicAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return BLOCKED.check(mapped, 'ipv4');
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return false;
}

export class BlockedDestinationError extends Error {
  constructor(readonly host: string, readonly address: string) {
    super(`blocked non-public destination ${host} (${address})`);
    this.name = 'BlockedDestinationError';
  }
}

/** Reject an IP-literal URL host that is non-public (hostnames are checked at connect time). */
export function assertPublicLiteralHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return; // unparseable — the request itself will fail
  }
  if (host === 'localhost' || host.endsWith('.localhost')) throw new BlockedDestinationError(host, host);
  if (net.isIP(host) && isNonPublicAddress(host)) throw new BlockedDestinationError(host, host);
}

type LookupFn = typeof dns.lookup;

/** `dns.lookup` wrapper that fails the connection when the host resolves to a non-public address. */
export function guardedLookup(resolve: LookupFn = dns.lookup): LookupFn {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses as dns.LookupAddress[];
      const bad = list.find((a) => isNonPublicAddress(a.address));
      if (bad) return callback(new BlockedDestinationError(hostname, bad.address));
      if (options?.all) return callback(null, list);
      return callback(null, list[0]?.address, list[0]?.family);
    });
  }) as LookupFn;
}

/** Shared dispatcher for untrusted-URL fetches. */
export const publicInternetAgent = new Agent({ connect: { lookup: guardedLookup() } });
