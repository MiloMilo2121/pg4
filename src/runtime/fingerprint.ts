/**
 * Realistic browser fingerprints for the undici HTTP clients.
 *
 * The old default UA was a DECLARED BOT (`pg4/0.1 (github…)`, defaults.ts) —
 * trivially blockable and it makes some sites serve a stripped page, hurting
 * BOTH scrape recall and enrichment extraction (direct_fetch reads company
 * sites with it). This pool + coherent client-hints presents as a normal
 * desktop browser.
 *
 * Picks are DETERMINISTIC (hash of a seed, e.g. hostname) — no RNG — so
 * fixture mode stays byte-identical and a given host keeps ONE identity within
 * a run. This is rotation, not aggression: the politeness rate-limits are
 * unchanged.
 */

export interface Fingerprint {
  userAgent: string;
  headers: Record<string, string>;
}

interface UaEntry {
  ua: string;
  platform: string;
  /** sec-ch-ua brands; empty for Firefox (which does not send client hints). */
  brands: string;
}

const UAS: ReadonlyArray<UaEntry> = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform: '"macOS"',
    brands: '"Chromium";v="125", "Google Chrome";v="125", "Not.A/Brand";v="24"',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform: '"Windows"',
    brands: '"Chromium";v="125", "Google Chrome";v="125", "Not.A/Brand";v="24"',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    platform: '"Windows"',
    brands: '',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0',
    platform: '"macOS"',
    brands: '',
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: '"Linux"',
    brands: '"Chromium";v="124", "Google Chrome";v="124", "Not.A/Brand";v="24"',
  },
];

/** Default realistic UA (pool head) — for callers that don't seed per-host. */
export const DEFAULT_USER_AGENT = UAS[0].ua;

/** The realistic UA pool (read-only) — exposed for tests + the browser factory. */
export const USER_AGENTS: ReadonlyArray<string> = UAS.map((u) => u.ua);

/** FNV-1a — a tiny deterministic string hash (no crypto, no RNG). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic browser fingerprint for a seed (e.g. a hostname). The same seed
 * always yields the same identity; no seed → the pool head. Returns the UA plus
 * coherent request headers (accept, accept-language it-IT, sec-fetch-*, and the
 * sec-ch-ua client hints that match the chosen browser — omitted for Firefox).
 */
export function fingerprintFor(seed?: string): Fingerprint {
  const entry = seed ? UAS[hash(seed) % UAS.length] : UAS[0];
  const headers: Record<string, string> = {
    'user-agent': entry.ua,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  };
  if (entry.brands) {
    headers['sec-ch-ua'] = entry.brands;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = entry.platform;
  }
  return { userAgent: entry.ua, headers };
}
