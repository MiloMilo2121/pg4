import type { Lead } from '../types/lead';

/**
 * Raw-lead deduplicator used by the scraper to collapse results from
 * multiple sources (PG + Maps + …). Uses a multi-key index — a record is
 * a duplicate if ANY of these match:
 *   - normalized phone
 *   - normalized (name + city)
 *   - normalized (name + first 3 address tokens)
 *   - pg_url (canonical)
 *   - maps_url (canonical)
 *   - website registrable host
 *
 * Merge policy is conservative: incoming fields fill in only what the
 * existing record is missing. Existing values always win on conflict —
 * the FIRST source wins. To bias toward a richer source, push that source
 * first (e.g. PG before Maps for Italian SMBs, since PG addresses are more
 * structured).
 */
export interface DedupReviewCandidate {
  /** Why the pair was flagged. */
  rule: 'token_sort_name_city' | 'shared_registrable_host';
  key: string;
  existing: Pick<Lead, 'company_name' | 'city' | 'address' | 'phone' | 'source' | 'website'>;
  incoming: Pick<Lead, 'company_name' | 'city' | 'address' | 'phone' | 'source' | 'website'>;
}

export class Deduplicator {
  private byPhone = new Map<string, Lead>();
  private byNameCity = new Map<string, Lead>();
  private byNameAddr = new Map<string, Lead>();
  private byPgUrl = new Map<string, Lead>();
  private byMapsUrl = new Map<string, Lead>();
  private byHost = new Map<string, Lead>();
  /**
   * Phase C.3 — auxiliary token-sorted name index for NEAR-duplicate
   * detection. "Immobiliare Rossi | padova" and "Rossi Immobiliare |
   * padova" produce different primary keys but the same sorted-token
   * key. Candidates are LOGGED for operator review, never auto-merged —
   * word order can be load-bearing in Italian business names
   * ("Studio Casa" vs "Casa Studio" are distinct registered firms).
   */
  private bySortedNameCity = new Map<string, Lead>();
  /**
   * Gate-0 — first lead seen per registrable domain (eTLD+1). Used to flag
   * same-domain / different-name pairs for review (see add()).
   */
  private byRegistrableHost = new Map<string, Lead>();
  private reviewCandidates: DedupReviewCandidate[] = [];

  find(item: Lead): Lead | undefined {
    const phone = this.phoneKey(item);
    if (phone && this.byPhone.has(phone)) return this.byPhone.get(phone);
    const nc = this.nameCityKey(item);
    if (nc && this.byNameCity.has(nc)) return this.byNameCity.get(nc);
    const na = this.nameAddrKey(item);
    if (na && this.byNameAddr.has(na)) return this.byNameAddr.get(na);
    if (item.pg_url && this.byPgUrl.has(item.pg_url)) return this.byPgUrl.get(item.pg_url);
    if (item.maps_url && this.byMapsUrl.has(item.maps_url)) return this.byMapsUrl.get(item.maps_url);
    const host = this.hostKey(item.website);
    if (host && this.byHost.has(host)) return this.byHost.get(host);
    return undefined;
  }

  add(item: Lead): void {
    const phone = this.phoneKey(item);
    if (phone) this.byPhone.set(phone, item);
    const nc = this.nameCityKey(item);
    if (nc) this.byNameCity.set(nc, item);
    const na = this.nameAddrKey(item);
    if (na) this.byNameAddr.set(na, item);
    if (item.pg_url) this.byPgUrl.set(item.pg_url, item);
    if (item.maps_url) this.byMapsUrl.set(item.maps_url, item);
    const host = this.hostKey(item.website);
    if (host) this.byHost.set(host, item);
    // Phase C.3 — near-duplicate detection. Fires when the sorted-token
    // key collides but the primary name+city key does not (requires the
    // same words in a different order). Candidate is logged, not merged.
    const sk = this.sortedNameCityKey(item);
    if (sk) {
      const near = this.bySortedNameCity.get(sk);
      if (near && near !== item && this.nameCityKey(near) !== nc) {
        this.reviewCandidates.push({
          rule: 'token_sort_name_city',
          key: sk,
          existing: pickReviewFields(near),
          incoming: pickReviewFields(item),
        });
      }
      if (!near) this.bySortedNameCity.set(sk, item);
    }
    // Gate-0 — shared-registrable-host review trigger. Two records on the
    // SAME registrable domain (eTLD+1) but with different name+city keys are
    // most often the same business recorded twice (apex vs www, or a content
    // page vs the home page) — the full-host index above did not catch them
    // because the hostnames differ. We FLAG them for review (never auto-merge:
    // the website link could be incidental). EXCLUDED: franchise siblings,
    // where both records sit on different non-www subdomains of a shared
    // brand domain (e.g. padova1.tecnocasaimpresa.it vs padova2.…) — those
    // are legitimately distinct branches.
    const reg = registrableHostKey(item.website);
    if (reg) {
      const prior = this.byRegistrableHost.get(reg);
      if (prior && prior !== item && this.nameCityKey(prior) !== nc && !looksLikeFranchiseSiblings(prior.website, item.website)) {
        this.reviewCandidates.push({
          rule: 'shared_registrable_host',
          key: reg,
          existing: pickReviewFields(prior),
          incoming: pickReviewFields(item),
        });
      }
      if (!prior) this.byRegistrableHost.set(reg, item);
    }
  }

  /** Phase C.3 — near-duplicate pairs flagged during this run (review-only). */
  getReviewCandidates(): DedupReviewCandidate[] {
    return this.reviewCandidates;
  }

  /**
   * Conservative merge: only fill in fields that `existing` is missing.
   * Existing values are NEVER overwritten on scalar fields — caller
   * chooses authority by order of `add()` calls.
   *
   * EXCEPTION: `sources[]` is treated as a UNION (Phase 3.7) — pg3 used
   * a delimited string and lost provenance. pg4 keeps every contributing
   * source visible.
   */
  merge(existing: Lead, incoming: Lead): void {
    for (const [k, v] of Object.entries(incoming)) {
      if (v === undefined || v === null || v === '') continue;
      if (k === 'sources' && Array.isArray(v)) {
        const cur = Array.isArray(existing.sources) ? existing.sources : existing.source ? [existing.source] : [];
        const set = new Set([...cur, ...(v as string[])]);
        existing.sources = Array.from(set);
        continue;
      }
      if (existing[k] === undefined || existing[k] === null || existing[k] === '') {
        (existing as Record<string, unknown>)[k] = v;
      }
    }
    // Update lookup tables in case the merged record has new keys we should index.
    this.add(existing);
  }

  size(): number {
    return this.byNameCity.size || this.byNameAddr.size;
  }

  private phoneKey(item: Lead): string | undefined {
    return computePhoneKey(item);
  }

  /**
   * name+city key. Requires a real city/locality to avoid over-merging
   * generic names ("Pizzeria", "Studio") that share an empty city slot.
   *
   * Locality lookup order: `city` → `business_city` → `query_location`.
   * If none of these are populated, no key is produced — the deduper
   * falls back to its other indexes (phone, name+address tokens, urls,
   * host) and the records stay distinct.
   */
  private nameCityKey(item: Lead): string | undefined {
    return computeNameCityKey(item);
  }

  /**
   * Fallback key for cards without a city tag. Concatenates the normalized
   * company name with the first 2 non-numeric address tokens — typically
   * `"Via"` + the street name. Two records that share name + street but
   * differ in civic number / ZIP / appended comune still collapse.
   *
   * (Slicing 3 tokens included a third token like the comune for one
   * source and a civic number for another, producing mismatched keys.
   * Two tokens is the lowest-noise signal.)
   */
  private nameAddrKey(item: Lead): string | undefined {
    return computeNameAddrKey(item);
  }

  /**
   * Phase C.3 — sorted-token variant of nameCityKey. Same locality rules;
   * name tokens are sorted so word order stops mattering. Only produced
   * for names with ≥ 2 tokens (single-token names cannot reorder).
   */
  private sortedNameCityKey(item: Lead): string | undefined {
    if (!item.company_name) return undefined;
    const tokens = normalizeCompanyNameForKey(item.company_name).split(' ').filter(Boolean);
    if (tokens.length < 2) return undefined;
    const localitySource = item.city ?? item.business_city ?? item.query_location ?? '';
    const c = normalizeForKey(localitySource);
    if (c.length < 2) return undefined;
    return `${tokens.sort().join(' ')}|${c}`;
  }

  private hostKey(website: string | undefined): string | undefined {
    return computeHostKey(website);
  }
}

// ---------------------------------------------------------------------------
// Exported pure key builders — the SINGLE source of truth for dedup keys,
// shared by the in-memory Deduplicator AND the persistence layer's
// computeDedupKey (src/persistence/dedup_key.ts), so the DB unique constraint
// can never drift from the scraper's dedup behaviour.
// ---------------------------------------------------------------------------

export function computePhoneKey(item: Lead): string | undefined {
  if (!item.phone) return undefined;
  let digits = item.phone.replace(/\D/g, '');
  if (digits.startsWith('0039')) digits = digits.slice(4);
  else if (digits.length >= 11 && digits.startsWith('39')) digits = digits.slice(2);
  return digits.length >= 8 ? digits : undefined;
}

export function computeNameCityKey(item: Lead): string | undefined {
  if (!item.company_name) return undefined;
  const n = normalizeCompanyNameForKey(item.company_name);
  if (n.length < 3) return undefined;
  const localitySource = item.city ?? item.business_city ?? item.query_location ?? '';
  const c = normalizeForKey(localitySource);
  if (c.length < 2) return undefined;
  return `${n}|${c}`;
}

export function computeNameAddrKey(item: Lead): string | undefined {
  if (!item.company_name || !item.address) return undefined;
  const n = normalizeCompanyNameForKey(item.company_name);
  if (n.length < 3) return undefined;
  const addrTokens = normalizeForKey(item.address)
    .split(' ')
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
    .slice(0, 2)
    .join(' ');
  return addrTokens ? `${n}|addr:${addrTokens}` : undefined;
}

export function computeHostKey(website: string | undefined): string | undefined {
  if (!website) return undefined;
  try {
    return new URL(website.startsWith('http') ? website : `https://${website}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function pickReviewFields(l: Lead): DedupReviewCandidate['existing'] {
  return { company_name: l.company_name, city: l.city, address: l.address, phone: l.phone, source: l.source, website: l.website };
}

function normalizeForKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Gate-0 — company-name key normalization that ALSO canonicalizes Italian
 * legal forms so punctuation/spacing variants of the same entity collapse.
 *
 * The base `normalizeForKey` turns "Immobiliare S.r.l." into "immobiliare s
 * r l" but "Immobiliare SRL" into "immobiliare srl" — different keys, so the
 * same firm leaked as two records (a measured ~3-4% of the duplicate rate).
 * Here we re-join the spaced-out legal-form letters into their canonical
 * token ("s r l" → "srl", "s p a" → "spa", …). The form is CANONICALIZED,
 * not stripped: "Rossi SRL" and "Rossi SPA" stay distinct (different forms),
 * but "Rossi S.R.L." and "Rossi SRL" now match. Order: longest first.
 */
export function normalizeCompanyNameForKey(s: string): string {
  let n = normalizeForKey(s);
  n = n
    .replace(/\bs\s+r\s+l\s+s\b/g, 'srls') // società a responsabilità limitata semplificata
    .replace(/\bs\s+a\s+p\s+a\b/g, 'sapa') // società in accomandita per azioni
    .replace(/\bs\s+r\s+l\b/g, 'srl')
    .replace(/\bs\s+p\s+a\b/g, 'spa')
    .replace(/\bs\s+n\s+c\b/g, 'snc')
    .replace(/\bs\s+a\s+s\b/g, 'sas');
  return n.replace(/\s+/g, ' ').trim();
}

/**
 * Registrable domain (eTLD+1) heuristic: last two labels of the hostname.
 * Good enough for Italian SMB sites (overwhelmingly `name.it`/`name.com`).
 * Returns undefined for unparseable input or bare hostnames.
 */
function registrableHostKey(website: string | undefined): string | undefined {
  if (!website) return undefined;
  let host: string;
  try {
    host = new URL(website.startsWith('http') ? website : `https://${website}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const labels = host.replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return undefined;
  return labels.slice(-2).join('.');
}

/** The subdomain part of a host (labels before the registrable domain), www stripped. */
function subdomainLabel(website: string | undefined): string {
  if (!website) return '';
  let host: string;
  try {
    host = new URL(website.startsWith('http') ? website : `https://${website}`).hostname.toLowerCase();
  } catch {
    return '';
  }
  const labels = host.replace(/\.$/, '').split('.').filter((l) => l && l !== 'www');
  return labels.slice(0, Math.max(0, labels.length - 2)).join('.');
}

/**
 * Two sites are FRANCHISE SIBLINGS when both sit on a distinct, non-www
 * subdomain of the same registrable domain (e.g. `padova1.tecnocasa.it`
 * vs `padova2.tecnocasa.it`). A single company virtually never splits
 * itself across two custom subdomains, so this pattern means independent
 * branches — not a duplicate. (apex-vs-www, or apex-vs-subdomain, is NOT a
 * franchise pattern and stays reviewable.)
 */
function looksLikeFranchiseSiblings(a: string | undefined, b: string | undefined): boolean {
  const sa = subdomainLabel(a);
  const sb = subdomainLabel(b);
  return sa.length > 0 && sb.length > 0 && sa !== sb;
}

/**
 * Pure functional dedupe: returns a new array with duplicates merged in
 * order of appearance. Convenient for tests and small batches.
 */
export function dedupeLeads(items: Lead[]): Lead[] {
  const dd = new Deduplicator();
  const out: Lead[] = [];
  for (const item of items) {
    const existing = dd.find(item);
    if (existing) {
      dd.merge(existing, item);
    } else {
      dd.add(item);
      out.push(item);
    }
  }
  return out;
}
