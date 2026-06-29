import * as cheerio from 'cheerio';
import { isDirectoryOrSocial, isExtractableRegistry } from './content_filter';

/**
 * R3 — registry-as-evidence (NOT as official_website).
 *
 * pg3's `SerpDeduplicator` keeps EXTRACTABLE_REGISTRIES around as
 * "low-rank candidates" so a downstream stage can pivot from a
 * registry hit (paginegialle / fatturatoitalia / registroimprese / …)
 * to the official site, OR at least extract structured data (P.IVA,
 * phone, email) the lead is missing.
 *
 * pg4 today has the registry list (`isExtractableRegistry`) but no
 * extraction stage downstream — so registries that survive the dedup
 * ranker get fetched by `verifyCandidates` and the gate matches the
 * company name visible on the directory page, producing FPs.
 *
 * This module fills that gap. It exposes:
 *
 *   1. `classifyCandidate(url)` — splits a SERP candidate into one
 *      of three buckets:
 *        - `OFFICIAL_CANDIDATE`   maybe the firm's own site → verify
 *        - `REGISTRY_EVIDENCE`    extractable registry → harvest, do NOT
 *                                 ever set as `lead.official_website`
 *        - `DIRECTORY_NOISE`      pure directory/social → drop
 *
 *   2. `harvestGenericRegistryEvidence(url, html)` — extracts
 *      vat_code / phone / email / name / address from a registry page
 *      using the same JSON-LD + regex pattern as `PgDetailHarvester`
 *      but without PG-specific selectors. Works for fatturatoitalia,
 *      reportaziende, registroimprese-style pages.
 *
 *   3. `RegistryEvidence` — typed result, carries the source URL and
 *      a `registry_id` so R4 (SmartSerperGate) can decide what to
 *      pivot on.
 *
 * R3 is intentionally pure (modulo the cheerio parse). All HTTP
 * fetching is done by the caller. Tests stay 0-network.
 */

export type SerpEvidenceClass = 'OFFICIAL_CANDIDATE' | 'REGISTRY_EVIDENCE' | 'DIRECTORY_NOISE';

export interface ClassifiedCandidate {
  url: string;
  host: string;
  classification: SerpEvidenceClass;
  /** When `REGISTRY_EVIDENCE` — which registry. Used by R4 to pick
   *  the right extractor (pg → PgDetailHarvester, others → generic). */
  registry_id?: RegistryId;
}

export type RegistryId =
  | 'paginegialle'
  | 'fatturatoitalia'
  | 'reportaziende'
  | 'guidatitolari'
  | 'visura'
  | 'registroimprese'
  | 'ufficiocamerale'
  | 'unknown_registry';

export interface RegistryEvidence {
  source_url: string;
  registry_id: RegistryId;
  vat_code?: string;
  phone?: string;
  email?: string;
  name?: string;
  address?: string;
}

const REGISTRY_HOSTS: Record<RegistryId, string[]> = {
  paginegialle: ['paginegialle.it'],
  fatturatoitalia: ['fatturatoitalia.it'],
  reportaziende: ['reportaziende.it'],
  guidatitolari: ['guidatitolari.it'],
  visura: ['visura.pro'],
  registroimprese: ['registroimprese.it'],
  ufficiocamerale: ['ufficiocamerale.it'],
  unknown_registry: [],
};

function hostnameOf(url: string): string {
  try {
    const h = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./i, '').toLowerCase();
    // Reject malformed hosts without a TLD (URL parser accepts bare
    // tokens like `not-a-url` as hostnames). A real SERP result always
    // has at least one dot.
    if (!h || !h.includes('.')) return '';
    return h;
  } catch {
    return '';
  }
}

function matchRegistryId(host: string): RegistryId | undefined {
  for (const [id, hosts] of Object.entries(REGISTRY_HOSTS) as [RegistryId, string[]][]) {
    for (const h of hosts) {
      if (host === h || host.endsWith(`.${h}`)) return id;
    }
  }
  return undefined;
}

/**
 * Three-bucket classifier. Order matters:
 *   - extractable registry FIRST (registries are also in DIRECTORIES,
 *     but we want to keep them around as evidence)
 *   - directory/social SECOND (drop)
 *   - everything else is treated as an official-site candidate
 */
export function classifyCandidate(url: string): ClassifiedCandidate {
  const host = hostnameOf(url);
  if (!host) {
    return { url, host: '', classification: 'DIRECTORY_NOISE' };
  }
  if (isExtractableRegistry(`https://${host}`)) {
    const registry_id = matchRegistryId(host) ?? 'unknown_registry';
    return { url, host, classification: 'REGISTRY_EVIDENCE', registry_id };
  }
  if (isDirectoryOrSocial(`https://${host}`)) {
    return { url, host, classification: 'DIRECTORY_NOISE' };
  }
  return { url, host, classification: 'OFFICIAL_CANDIDATE' };
}

/**
 * Convenience: classify a list of candidate URLs and return the
 * three buckets separately. R4 will iterate `official` for normal
 * verification and `registry` for evidence-only pivots.
 */
export function partitionSerpCandidates(urls: string[]): {
  official: ClassifiedCandidate[];
  registry: ClassifiedCandidate[];
  noise: ClassifiedCandidate[];
} {
  const official: ClassifiedCandidate[] = [];
  const registry: ClassifiedCandidate[] = [];
  const noise: ClassifiedCandidate[] = [];
  for (const u of urls) {
    const c = classifyCandidate(u);
    if (c.classification === 'OFFICIAL_CANDIDATE') official.push(c);
    else if (c.classification === 'REGISTRY_EVIDENCE') registry.push(c);
    else noise.push(c);
  }
  return { official, registry, noise };
}

/**
 * Generic JSON-LD + regex registry extractor. Works for any registry
 * that exposes a `LocalBusiness` / `Organization` JSON-LD block with
 * standard keys (vatID/taxID, telephone, email, name, address) — that
 * covers fatturatoitalia, reportaziende, and several smaller
 * Italian registries.
 *
 * Falls back to regex on the raw HTML for vatID/email/telephone, and
 * to visible <h1> for name. Returns null when nothing useful was
 * found (so R4 doesn't waste a backfill round-trip).
 *
 * Same shape as `PgDetailHarvester.extractCompanyDetails` — the two
 * could share an internal helper, but keeping this independent
 * means a future PG-selector change doesn't accidentally regress
 * generic-registry parsing.
 */
export function harvestGenericRegistryEvidence(
  url: string,
  html: string,
): RegistryEvidence | null {
  if (!html || html.length < 200) return null;
  const host = hostnameOf(url);
  if (!host) return null;
  const registry_id = matchRegistryId(host) ?? 'unknown_registry';

  const $ = cheerio.load(html);

  let vat: string | undefined;
  let phone: string | undefined;
  let email: string | undefined;
  let name: string | undefined;
  let address: string | undefined;

  // 1 — JSON-LD walk
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      walkJson(parsed, (k, v) => {
        const key = k.toLowerCase();
        if (!vat && (key === 'vatid' || key === 'taxid')) {
          const maybe = extractFirstVat(v);
          if (maybe) vat = maybe;
        }
        if (!phone && key === 'telephone' && typeof v === 'string') {
          phone = v.trim();
        }
        if (!email && key === 'email' && typeof v === 'string') {
          email = v.trim().toLowerCase();
        }
        if (!name && key === 'name' && typeof v === 'string') {
          name = v.trim();
        }
        if (!address && (key === 'streetaddress' || key === 'address') && typeof v === 'string') {
          address = v.trim();
        }
      });
    } catch {
      /* malformed JSON — silently ignored */
    }
  });

  // 2 — Regex fallbacks against raw HTML (covers pages that put VAT
  // /email/phone in plain text or in non-JSON-LD attributes).
  if (!vat) {
    // Match either "vatID":"IT01234567890" or visible "P.IVA 01234567890"
    const m1 = html.match(/"(?:vatID|taxID)"\s*:\s*"(?:IT)?(\d{11})"/i);
    const m2 = html.match(/\b(?:P\.?\s*IVA|partita\s+iva|VAT)\s*[:.\-]?\s*(?:IT)?\s*(\d{11})\b/i);
    if (m1?.[1]) vat = m1[1];
    else if (m2?.[1]) vat = m2[1];
  }
  if (!email) {
    const m = html.match(/"email"\s*:\s*"([^"]+)"/i)
      ?? html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    if (m) email = (m[1] ?? m[0]).trim().toLowerCase();
  }
  if (!phone) {
    const m = html.match(/"telephone"\s*:\s*"([^"]+)"/i);
    if (m?.[1]) phone = m[1].trim();
  }

  // 3 — Visible-text name fallback
  if (!name) {
    const h1 = $('h1').first().text().trim();
    if (h1) name = h1;
  }

  if (!vat && !phone && !email && !name && !address) return null;
  return { source_url: url, registry_id, vat_code: vat, phone, email, name, address };
}

/* ------------------------------------------------------------------ *
 * Internal helpers — duplicated from PgDetailHarvester on purpose so
 * a future PG-specific change can't regress generic-registry parsing.
 * ------------------------------------------------------------------ */

function walkJson(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkJson(item, visit);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      visit(k, v);
      walkJson(v, visit);
    }
  }
}

function extractFirstVat(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = value.match(/(\d{11})/);
  return m?.[1];
}
