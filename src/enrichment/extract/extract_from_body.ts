/**
 * Phase 1 (free-gold) — PURE extractor over an already-fetched website body.
 *
 * pg4 already HTTP-fetches a company's official website to VERIFY it
 * (direct_fetch → verify_candidates → VerifyVerdict.body on a strong
 * piva/phone match). That body is then used only for the paid-gate and
 * discarded. This module mines it for contact intelligence — email, PEC,
 * social profiles, P.IVA, extra phones — at ZERO marginal HTTP cost.
 *
 * Hard contract: PURE. No network, no router, no I/O, synchronous. Every
 * value is derived from the supplied HTML string. cheerio is the only dep
 * (already used by the financial parser and the Maps parser).
 *
 * Quality discipline (Italian SMB sites): emails are accepted only when
 * they sit on the firm's OWN registrable domain (rejects gmail/3rd-party/
 * directory addresses); PEC is split out by certified-mail domain; social
 * links must look like profile/company URLs, not share-intent widgets.
 */
import * as cheerio from 'cheerio';
import { extractVatCodesFromText } from '../financial/vat';
import { isPecAddress } from './pec';

/** The social networks pg4 extracts. Single source of truth for the field keys. */
export type SocialKey = 'instagram' | 'facebook' | 'linkedin' | 'tiktok' | 'youtube';

export interface BodyExtraction {
  /** Business email on the firm's own domain. */
  email?: string;
  /** Italian certified email (PEC), recognised by domain. */
  pec?: string;
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  tiktok?: string;
  youtube?: string;
  /** Checksum-valid P.IVA codes found in the page (footer/legal text). */
  vat_candidates: string[];
  /** Italian phone-shaped strings found on the page (normalised, deduped). */
  phones: string[];
  /** og:site_name / JSON-LD Organization name — used to CORROBORATE the entity. */
  site_name?: string;
  /** schema.org founder / legalName — a weak, high-precision decision-maker hint. */
  founder?: string;
  /** schema.org foundingDate → 4-digit year. */
  founding_year?: string;
  /** schema.org aggregateRating — reputation (judgment A-axis). */
  rating?: string;
  reviews_count?: string;
}

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
/** Italian phone: optional +39, 0xx landline or 3xx mobile, with spacing. */
const PHONE_RE = /(?:\+39\s?)?(?:0\d{1,4}|3\d{2})[\s\-./]?\d[\d\s\-./]{4,12}\d/g;

/** Profile/company URL shapes per network; share/intent/plugin links rejected. */
const SOCIAL_PATTERNS: Array<{ key: SocialKey; host: RegExp; reject: RegExp }> = [
  { key: 'instagram', host: /(?:^|\.)instagram\.com$/i, reject: /\/(?:p|reel|explore|accounts|share)\b/i },
  { key: 'facebook', host: /(?:^|\.)facebook\.com$/i, reject: /\/(?:sharer|share|plugins|dialog|tr\b|events|photo)/i },
  { key: 'linkedin', host: /(?:^|\.)linkedin\.com$/i, reject: /\/(?:shareArticle|sharing|share-offsite|feed|posts)/i },
  { key: 'tiktok', host: /(?:^|\.)tiktok\.com$/i, reject: /\/(?:video|tag|search|discover|foryou|live)\b/i },
  { key: 'youtube', host: /(?:^|\.)(?:youtube\.com|youtu\.be)$/i, reject: /\/(?:watch|embed|results|shorts|playlist|feed)\b/i },
];

/** Match a single URL against SOCIAL_PATTERNS → {key, normalisedUrl} or undefined. */
export function matchSocialUrl(href: string): { key: SocialKey; url: string } | undefined {
  let host: string;
  let path: string;
  try {
    const u = new URL(href);
    host = u.hostname.toLowerCase();
    path = u.pathname + u.search;
  } catch {
    return undefined;
  }
  for (const pat of SOCIAL_PATTERNS) {
    if (pat.host.test(host) && path.length > 1 && !pat.reject.test(path)) {
      return { key: pat.key, url: `https://${host.replace(/^www\./, '')}${path.split('?')[0].split('#')[0]}`.replace(/\/$/, '') };
    }
  }
  return undefined;
}

/**
 * Registrable domain heuristic: last two labels. Good enough for Italian
 * SMB sites (overwhelmingly `name.it` / `name.com`); intentionally simple
 * and dependency-free. Used only to decide "is this email on the firm's
 * own domain", a conservative filter — over-rejection is safe.
 */
export function registrableDomain(hostOrUrl: string | undefined | null): string | undefined {
  if (!hostOrUrl) return undefined;
  let host = String(hostOrUrl).trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0].split('#')[0];
  if (!host || !host.includes('.')) return undefined;
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return undefined;
  return labels.slice(-2).join('.');
}

function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at < 0) return undefined;
  return registrableDomain(email.slice(at + 1));
}

/**
 * Extract contact intelligence from an already-fetched website body.
 * Never throws on malformed HTML (cheerio is forgiving); returns an empty
 * extraction (with `vat_candidates: []`, `phones: []`) when nothing is found.
 */
export function extractFromBody(html: string | undefined | null, lead: { official_website?: string }): BodyExtraction {
  const out: BodyExtraction = { vat_candidates: [], phones: [] };
  if (!html || html.length < 50) return out;

  const ownDomain = registrableDomain(lead.official_website);
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return out; // unparseable — caller keeps whatever it had
  }

  // ---- Emails: mailto: hrefs first (highest-confidence), then Cloudflare
  // email-protection, then the (de-obfuscated) body text ----
  const emailCandidates = new Set<string>();
  $('a[href^="mailto:" i]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    const addr = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (addr.includes('@')) emailCandidates.add(addr);
  });
  // Cloudflare email obfuscation: a real address the plain-text scan can NEVER
  // see because Cloudflare replaced it in the DOM with `data-cfemail="HEX"`
  // (and/or an `/cdn-cgi/l/email-protection#HEX` href). Deterministic XOR decode.
  $('[data-cfemail]').each((_i, el) => {
    const dec = decodeCfEmail($(el).attr('data-cfemail'));
    if (dec) emailCandidates.add(dec);
  });
  $('a[href*="/cdn-cgi/l/email-protection#" i]').each((_i, el) => {
    const dec = decodeCfEmail(($(el).attr('href') ?? '').split('#')[1]);
    if (dec) emailCandidates.add(dec);
  });
  const bodyText = $('body').length ? $('body').text() : $.root().text();
  for (const m of bodyText.matchAll(EMAIL_RE)) emailCandidates.add(m[0].toLowerCase());
  // Manual anti-scraper obfuscation: "info [at] studio [dot] it". Only BRACKETED
  // tokens are rewritten (bare " at "/" dot " would corrupt prose into fakes);
  // own-domain filtering below is the precision backstop for anything revealed.
  const deob = deobfuscateBrackets(bodyText);
  if (deob !== bodyText) for (const m of deob.matchAll(EMAIL_RE)) emailCandidates.add(m[0].toLowerCase());

  for (const addr of emailCandidates) {
    if (isPecAddress(addr)) {
      if (!out.pec) out.pec = addr;
      continue;
    }
    // Business email must be on the firm's own registrable domain (when known).
    if (ownDomain && emailDomain(addr) !== ownDomain) continue;
    if (!out.email) out.email = addr;
  }
  // If we have no own-domain email but a PEC exists, that's still useful (kept).
  // If ownDomain is unknown, accept the first non-PEC address as a weak email.
  if (!out.email && !ownDomain) {
    for (const addr of emailCandidates) {
      if (!isPecAddress(addr)) { out.email = addr; break; }
    }
  }

  // ---- schema.org JSON-LD (Organization/LocalBusiness): the HIGHEST-confidence
  // structured source — the firm DECLARES its socials (sameAs), name, contacts,
  // VAT, founder, and rating. Parsed first so it wins over loose href scanning. ----
  const jsonLdPhones = new Set<string>();
  const jsonLdVats = new Set<string>();
  for (const node of collectJsonLdOrgNodes($)) {
    for (const url of asArray(node.sameAs)) {
      const m = typeof url === 'string' ? matchSocialUrl(url) : undefined;
      if (m && !out[m.key]) out[m.key] = m.url;
    }
    if (!out.site_name) {
      const nm = strOf(node.legalName) ?? strOf(node.name);
      if (nm) out.site_name = nm;
    }
    const jsonEmail = strOf(node.email)?.replace(/^mailto:/i, '').toLowerCase();
    if (jsonEmail && jsonEmail.includes('@')) {
      if (isPecAddress(jsonEmail)) { if (!out.pec) out.pec = jsonEmail; }
      else if (!out.email && (!ownDomain || emailDomain(jsonEmail) === ownDomain)) out.email = jsonEmail;
    }
    const tel = strOf(node.telephone);
    if (tel) { const np = normalisePhone(tel); if (np) jsonLdPhones.add(np); }
    const vatId = strOf(node.vatID) ?? strOf(node.taxID);
    if (vatId) for (const v of extractVatCodesFromText(vatId)) jsonLdVats.add(v);
    if (!out.founder) {
      const f = strOf(node.founder) ?? strOf((node.founder as Record<string, unknown> | undefined)?.name);
      if (f) out.founder = f;
    }
    if (!out.founding_year) {
      const fd = strOf(node.foundingDate);
      const yr = fd?.match(/\b(19|20)\d{2}\b/)?.[0];
      if (yr) out.founding_year = yr;
    }
    const agg = node.aggregateRating as Record<string, unknown> | undefined;
    if (agg && !out.rating) {
      const rv = strOf(agg.ratingValue);
      const rc = strOf(agg.reviewCount) ?? strOf(agg.ratingCount);
      if (rv) out.rating = rv;
      if (rc) out.reviews_count = rc;
    }
  }

  // ---- Open Graph: og:site_name corroborates the entity when JSON-LD is absent. ----
  if (!out.site_name) {
    const og = $('meta[property="og:site_name" i]').attr('content')?.trim();
    if (og) out.site_name = og;
  }

  // ---- Social profiles: scan all hrefs (fills whatever sameAs did not) ----
  $('a[href]').each((_i, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || href.startsWith('#')) return;
    let abs: string;
    try {
      abs = new URL(href, lead.official_website ? `https://${registrableDomain(lead.official_website)}` : 'https://x.invalid').toString();
    } catch {
      return;
    }
    const m = matchSocialUrl(abs);
    if (m && !out[m.key]) out[m.key] = m.url;
  });

  // ---- VAT: reuse the checksum-validated extractor (no false positives) ----
  out.vat_candidates = [...new Set([...jsonLdVats, ...extractVatCodesFromText(bodyText)])];

  // ---- Phones: Italian-shaped, normalised, deduped ----
  const seenPhones = new Set<string>();
  // tel: hrefs are the cleanest source
  $('a[href^="tel:" i]').each((_i, el) => {
    const raw = ($(el).attr('href') ?? '').replace(/^tel:/i, '').trim();
    const norm = normalisePhone(raw);
    if (norm) seenPhones.add(norm);
  });
  for (const m of bodyText.matchAll(PHONE_RE)) {
    const norm = normalisePhone(m[0]);
    if (norm) seenPhones.add(norm);
  }
  for (const np of jsonLdPhones) seenPhones.add(np);
  out.phones = [...seenPhones];

  return out;
}

/**
 * Conservative Italian phone normalisation to a digit string with the
 * country prefix stripped (mirrors the deduper's phoneKey so downstream
 * dedup stays consistent). Returns undefined for implausible numbers.
 */
function normalisePhone(raw: string): string | undefined {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0039')) digits = digits.slice(4);
  else if (digits.length >= 11 && digits.startsWith('39')) digits = digits.slice(2);
  return digits.length >= 8 && digits.length <= 11 ? digits : undefined;
}

/**
 * Decode a Cloudflare-obfuscated email (`data-cfemail` / email-protection hex):
 * the first byte is the XOR key, each subsequent byte is a char XOR that key.
 * Returns a lowercased address, or undefined for malformed/non-email output.
 */
function decodeCfEmail(hex: string | undefined | null): string | undefined {
  if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length < 6 || hex.length % 2 !== 0) return undefined;
  const key = Number.parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  out = out.toLowerCase().trim();
  // Validate with a NON-global regex (never .test() the shared global EMAIL_RE:
  // its lastIndex is stateful and would desync the matchAll scans above).
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(out) ? out : undefined;
}

/**
 * Reveal emails hidden behind BRACKETED anti-scraper tokens:
 *   "info [at] studio [dot] it" · "info (at) studio (punto) it" → info@studio.it
 * Only bracketed/parenthesised/braced forms are rewritten; a bare " at " / " dot "
 * is deliberately left alone (it would turn ordinary prose into fake addresses).
 * CASE-SENSITIVE lowercase on purpose: Italian footers write the PROVINCE
 * SIGLA uppercase — "14053 Canelli (AT) www.rossivini.it" — and a
 * case-insensitive "(AT)"→@ fabricates canelli@www.rossivini.it, an
 * own-domain (accepted!) fake. Obfuscated emails use lowercase tokens;
 * an uppercase "(AT)" is an address, not an email.
 */
function deobfuscateBrackets(text: string): string {
  return text
    .replace(/\s*[[({]\s*(?:at|chiocciola)\s*[\])}]\s*/g, '@')
    .replace(/\s*[[({]\s*(?:dot|punto)\s*[\])}]\s*/g, '.');
}

// ---- JSON-LD helpers (schema.org structured data) ----

/** schema.org @types that carry company-level structured data. */
const ORG_TYPE_RE = /organization|localbusiness|corporation|\bstore\b|realestateagent|professionalservice|\bngo\b|\bcompany\b/i;

/**
 * Collect every JSON-LD node that looks like the company (Organization-like
 * @type, or carries `sameAs`/`aggregateRating`). Walks arrays + `@graph` +
 * nested objects, depth-capped, never throws on malformed JSON.
 */
function collectJsonLdOrgNodes($: cheerio.CheerioAPI): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  $('script[type="application/ld+json" i]').each((_i, el) => {
    const raw = ($(el).contents().text() || $(el).text() || '').trim();
    if (raw.length < 2) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // malformed JSON-LD — skip, keep the rest
    }
    walkJsonLd(parsed, out, 0);
  });
  return out;
}

function walkJsonLd(node: unknown, out: Array<Record<string, unknown>>, depth: number): void {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walkJsonLd(n, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const t = obj['@type'];
  const typeStr = Array.isArray(t) ? t.join(' ') : typeof t === 'string' ? t : '';
  if ((typeStr && ORG_TYPE_RE.test(typeStr)) || 'sameAs' in obj || 'aggregateRating' in obj) out.push(obj);
  for (const v of Object.values(obj)) if (v && typeof v === 'object') walkJsonLd(v, out, depth + 1);
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function strOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v) && v.length > 0) return strOf(v[0]);
  return undefined;
}
