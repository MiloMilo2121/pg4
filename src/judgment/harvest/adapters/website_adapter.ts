import type { Lead } from '../../../types/lead';
import type { Signal, EvidenceRef } from '../../../types/judgment';
import { extractFromBody, registrableDomain } from '../../../enrichment/extract/extract_from_body';
import type { SourceAdapter, HarvestContext, HarvestResult } from '../source_harvest';
import { SOURCE_TTL_DAYS } from '../routing';

/**
 * Website SourceAdapter — the fully-offline core (no key, no paid call). Fetches
 * the homepage ONCE and extracts BOTH contact attributes (reusing the Phase-1
 * pure extractor) AND owned-channel (Axis-B) signals from the same markup. This
 * is the free-gold principle generalized: one fetch, many outputs.
 *
 * Ownership note (watch-item #3): a social link printed ON the official site is
 * the PRIMARY proof of ownership → these socials are emitted as B presence
 * signals here; handles found only via search stay weaker (social_adapter).
 */

function normalizeUrl(site: string): string {
  const s = site.trim();
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
}

function ev(url: string, excerpt: string, iso: string, confidence = 0.8): EvidenceRef {
  return { source: 'website_body', url, excerpt, observedAt: iso, confidence };
}

/** Deterministic Axis-B markers read from the homepage HTML. Conservative:
 *  emits ONLY positive (confirmed_present) observations — a missing marker is
 *  left to the collector as `unknown`, never `confirmed_absent`. */
export function websiteBSignals(html: string, url: string, iso: string): Signal[] {
  const out: Signal[] = [];
  const lc = html.toLowerCase();
  const markers: string[] = [];
  if (/<h1[\s>]/i.test(html)) markers.push('has_h1');
  const copy = html.match(/(?:©|&copy;|copyright)\s*\D{0,12}(20\d{2})/i);
  if (copy) markers.push(`copyright:${copy[1]}`);
  const langs = new Set<string>();
  const htmlLang = html.match(/<html[^>]+lang=["']?([a-z]{2})/i);
  if (htmlLang) langs.add(htmlLang[1].toLowerCase());
  for (const m of html.matchAll(/hreflang=["']?([a-z]{2})/gi)) langs.add(m[1].toLowerCase());
  if (langs.size > 0) markers.push(`lang:${[...langs].join(',')}`);
  if (url.startsWith('https')) markers.push('https');
  if (/(contatt|preventiv|richiedi|acquista|prenota|chiama ora|scopri di pi[uù])/i.test(lc)) markers.push('cta');
  if (/(case study|testimonianz|dicono di noi|recensioni|certificazion|premi[oa]\b|iso\s?9001)/i.test(lc)) markers.push('proof');

  // §3.1 — the site EXISTS (we fetched it): confirmed_present, with quality markers.
  out.push({
    axis: 'B',
    key: '3.1',
    state: 'confirmed_present',
    value: markers,
    evidence: [ev(url, `homepage markers: ${markers.join(', ') || 'none'}`, iso)],
    notes: 'website present; quality markers for Judge B',
  });

  // §3.15 multilingua is also an A-adjacent export/ambition validator, but the
  // OWNED-channel reading (a multilingual SITE) is a B signal here.
  if (langs.size > 1) {
    out.push({ axis: 'B', key: '3.1', state: 'confirmed_present', value: 'multilingua', evidence: [ev(url, `langs: ${[...langs].join(',')}`, iso)], notes: 'multilingua (export/ambition)' });
  }

  // §3.10 own e-commerce — positive marker only.
  if (/(carrello|aggiungi al carrello|checkout|add to cart|\/shop\b|negozio online|e-?commerce)/i.test(lc)) {
    out.push({ axis: 'B', key: '3.10', state: 'confirmed_present', value: 'ecommerce_markers', evidence: [ev(url, 'cart/checkout/shop markers', iso)] });
  }
  // §3.12 owned audience — newsletter signup.
  if (/(newsletter|iscriviti alla|subscribe|registrati per ricevere)/i.test(lc)) {
    out.push({ axis: 'B', key: '3.12', state: 'confirmed_present', value: 'newsletter_signup', evidence: [ev(url, 'newsletter/subscribe form', iso)] });
  }
  return out;
}

/** Map the body extraction's social links to B presence signals (owned-confirmed). */
function socialPresenceSignals(att: Record<string, string>, url: string, iso: string): Signal[] {
  const out: Signal[] = [];
  const map: Array<[keyof typeof att | string, string]> = [
    ['instagram', '3.5'],
    ['facebook', '3.5'],
    ['linkedin', '3.8'],
  ];
  for (const [attr, surface] of map) {
    const v = att[attr as string];
    if (v) out.push({ axis: 'B', key: surface, state: 'confirmed_present', value: v, evidence: [ev(url, `linked from site: ${v}`, iso, 0.85)], notes: 'ownership: link from official site (primary)' });
  }
  return out;
}

export class WebsiteSourceAdapter implements SourceAdapter {
  readonly kind = 'website' as const;
  readonly id = 'website_body';
  readonly tier = 0 as const;
  readonly costEur = 0;

  available(): boolean {
    return true; // free; relies only on having a site + a fetcher
  }

  ttlDays(): number | null {
    return SOURCE_TTL_DAYS.website;
  }

  locate(lead: Lead): string | undefined {
    const site = (lead.official_website as string | undefined) || (lead.website as string | undefined);
    if (!site || !registrableDomain(site)) return undefined;
    return normalizeUrl(site);
  }

  async harvest(locator: string, ctx: HarvestContext): Promise<HarvestResult> {
    const iso = new Date(ctx.now()).toISOString();
    const html = await ctx.fetcher(locator);
    if (!html) {
      return { source: this.kind, sourceId: this.id, locator, fetchedAt: iso, ok: false, attributes: {}, signals: [] };
    }
    const ex = extractFromBody(html, { official_website: locator } as Lead);
    const attributes: Record<string, string> = {};
    if (ex.email) attributes.email = ex.email;
    if (ex.pec) attributes.pec = ex.pec;
    if (ex.instagram) attributes.instagram = ex.instagram;
    if (ex.facebook) attributes.facebook = ex.facebook;
    if (ex.linkedin) attributes.linkedin = ex.linkedin;
    if (ex.vat_candidates[0]) attributes.vat = ex.vat_candidates[0];
    if (ex.phones[0]) attributes.phone = ex.phones[0];

    const signals: Signal[] = [...websiteBSignals(html, locator, iso), ...socialPresenceSignals(attributes, locator, iso)];
    return { source: this.kind, sourceId: this.id, locator, fetchedAt: iso, ok: true, attributes, signals, raw: undefined };
  }
}
