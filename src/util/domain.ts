import { getDomain, getSubdomain, parse } from 'tldts';

/**
 * Domain helpers on the Public Suffix List. One definition of "the firm's
 * domain" for dedupe, same-site filters, email ownership and RDAP, so
 * `x.altervista.org`, `foo.pd.it` and `foo.co.uk` never collapse to the
 * suffix they sit on.
 */

// Hosting platforms (altervista.org, blogspot.com, wixsite.com, myshopify.com…)
// sit in the PSL private section. Each tenant there is a different owner, so the
// tenant host is the registrable unit: two firms on the same platform must not
// read as the same site, and the platform apex is never the firm's homepage.
const PSL = { allowPrivateDomains: true, extractHostname: false } as const;

/**
 * Lowercased ASCII (punycode) hostname of a URL or bare host, without a
 * trailing dot. `undefined` when the input does not parse as a host.
 */
function hostOf(hostOrUrl: string | undefined | null): string | undefined {
  if (!hostOrUrl) return undefined;
  const s = String(hostOrUrl).trim();
  if (!s) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`);
    return url.hostname.toLowerCase().replace(/\.$/, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registrable domain (eTLD+1, private suffixes included) of a URL or host:
 * `www.rossi.it` → `rossi.it`, `foo.pd.it` → `foo.pd.it`,
 * `x.altervista.org` → `x.altervista.org`. `undefined` for IP literals,
 * single-label hosts (`localhost`) and bare suffixes (`co.uk`).
 */
export function registrableDomain(hostOrUrl: string | undefined | null): string | undefined {
  const host = hostOf(hostOrUrl);
  if (!host) return undefined;
  return getDomain(host, PSL) ?? undefined;
}

/**
 * Labels in front of the registrable domain, with a leading `www` dropped:
 * `padova1.tecnocasa.it` → `padova1`, `www.rossi.it` → `''`.
 */
export function subdomainOf(hostOrUrl: string | undefined | null): string {
  const host = hostOf(hostOrUrl);
  if (!host) return '';
  const sub = getSubdomain(host, PSL) ?? '';
  return sub.replace(/^www(?:\.|$)/, '');
}

/**
 * The domain a registry holds a record for (ICANN section only), for RDAP.
 * `shop.foo.it` → `foo.it`. `undefined` for a host on a shared-hosting
 * suffix: the registrant of `altervista.org` is the platform, and its record
 * says nothing about the tenant firm.
 */
export function registryDomain(hostOrUrl: string | undefined | null): string | undefined {
  const host = hostOf(hostOrUrl);
  if (!host) return undefined;
  const parsed = parse(host, PSL);
  if (parsed.isIp || parsed.isPrivate) return undefined;
  return parsed.domain ?? undefined;
}
