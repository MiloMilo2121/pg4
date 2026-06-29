import type { NormalizedLead } from '../../types/discovery';

/**
 * R2 — pg3-style multi-vector SERP query builder.
 *
 * Today pg4 emits ONE generic query per lead:
 *   `${name} ${city} P.IVA ${vat} sito ufficiale`
 *
 * pg3's `QuerySanitizer.buildQueryVariants(target='company')` instead
 * produces 8-12 ordered variants, each targeting a distinct evidence
 * vector (P.IVA, email-domain, exact-name, contacts, legal pages,
 * phone, address, official-site fallback). Every variant carries an
 * aggressive `-site:` exclusion dork list that keeps directory hits
 * out of the SERP page.
 *
 * This file ports pg3's `target='company'` path. Other targets
 * (linkedin/registry/bilancio) are intentionally OUT of scope — pg4
 * doesn't run those pipelines today.
 *
 * pg4 differences vs pg3:
 *   - the exclusion dork list mirrors pg4's most-frequent offenders
 *     instead of the legacy pg3 list (cercacasa.it, atoka.io,
 *     companyreports.it added; tripadvisor/yelp dropped — never seen
 *     in pg4 audits).
 *   - 10-variant cap (vs pg3's 12) — phase R6 will trim further if
 *     the benchmark shows a long tail of dead-end variants.
 *   - returns `QueryVariant[]` with `vector` + `priority` so the
 *     caller (SmartSerperGate, R4) can decide which subset is worth
 *     burning paid budget on.
 *
 * Stop-word check:
 *   pg3 returns `[]` when the company name reduces to legal-form
 *   abbreviations only (`"S.r.l." → ['srl']` → all stop words). We
 *   keep this rule verbatim — there's nothing useful to query when
 *   the name is just `srl` or `sas`.
 */

export type QueryVector =
  | 'piva'
  | 'email_domain'
  | 'exact_name'
  | 'contact'
  | 'legal'
  | 'phone'
  | 'address'
  | 'official'
  | 'fallback_contact';

export interface QueryVariant {
  /** Final query string, ≤200 chars, ready to hand to a SERP provider. */
  query: string;
  /** Which evidence vector this variant targets. */
  vector: QueryVector;
  /** 1 = strongest evidence, 9 = weakest fallback. Lower runs first. */
  priority: number;
}

export interface BuildQueryOptions {
  /** Max number of variants to return. Default 10. */
  maxVariants?: number;
  /** Override exclusion dork list (test only). */
  exclusionDorks?: string;
  /** When true, omit the `-site:` exclusion list — only used when the
   *  caller wants to compare directory-vs-official surfaces explicitly
   *  (e.g. R3 `serp_evidence.ts`). Default false. */
  omitExclusions?: boolean;
}

/**
 * `-site:` exclusion list. Keeps Serper / Bing / DDG from returning
 * directory results in the top 10 — saves a verify call AND removes
 * the temptation to set `lead.official_website` to a paginegialle URL.
 *
 * Capped at the offenders most frequently observed in pg4 audits
 * (G.1 + G.2 directory leak triage). The full DIRECTORIES content
 * filter (~80 hosts) would blow the 200-char query budget — these
 * 10 cover ~80 % of the FP volume.
 */
export const EXCLUSION_DORKS =
  '-site:facebook.com -site:linkedin.com -site:paginegialle.it -site:registroimprese.it ' +
  '-site:atoka.io -site:companyreports.it -site:europages.com -site:kompass.com ' +
  '-site:misterimprese.it -site:cercacasa.it';

/**
 * Italian legal-form abbreviations + connectives. A name that reduces
 * to ONLY these tokens after sanitisation is too weak to query — pg3
 * returns an empty variant list in that case.
 */
const STOP_WORDS = new Set([
  'srl', 's.r.l', 's.r.l.', 'spa', 's.p.a', 's.p.a.', 'snc', 's.n.c', 's.n.c.',
  'sas', 's.a.s', 's.a.s.', 'scarl', 'srls', 'sa', 'di', 'e', 'il', 'la', 'le',
  'i', 'un', 'una', 'da', 'per', 'con', 'su', '&',
]);

/**
 * Sanitise free-form text for inclusion in a SERP query string.
 *
 * - drop all quote characters (curly + straight + guillemets)
 * - replace special chars with space: ( ) [ ] { } < > | & ! ^ ~ * ? : / \
 * - replace apostrophes with space (defensive, in case the quote
 *   stripper missed a curly variant)
 * - collapse whitespace
 * - truncate to 200 chars
 */
export function sanitizeForQuery(text: string | undefined): string {
  if (!text) return '';
  let s = text;
  s = s.replace(/["'«»‹›„“”‘’]/g, '');
  s = s.replace(/[\(\)\[\]\{\}\<\>\|\&\!\^\~\*\?\:\/\\]/g, ' ');
  s = s.replace(/'/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 200) s = s.substring(0, 200).trim();
  return s;
}

function isOnlyStopWords(text: string): boolean {
  if (!text) return true;
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => STOP_WORDS.has(t));
}

function pushUnique(variants: QueryVariant[], seen: Set<string>, v: QueryVariant): void {
  const trimmed = v.query.trim().replace(/\s+/g, ' ');
  if (!trimmed) return;
  const final = trimmed.length > 200 ? trimmed.substring(0, 200).trim() : trimmed;
  if (seen.has(final)) return;
  seen.add(final);
  variants.push({ query: final, vector: v.vector, priority: v.priority });
}

/**
 * Extract the email domain from `lead.email` if `email_domain` isn't
 * already set. Defensive — `normalizeLead` should populate this, but
 * we don't trust callers to always pre-normalise.
 */
function resolveEmailDomain(input: NormalizedLead): string | undefined {
  if (input.email_domain) return input.email_domain.replace(/^www\./i, '').trim().toLowerCase();
  if (input.email) {
    const at = input.email.lastIndexOf('@');
    if (at > 0 && at < input.email.length - 1) {
      return input.email.substring(at + 1).replace(/^www\./i, '').trim().toLowerCase();
    }
  }
  return undefined;
}

/**
 * Build the ordered list of company-target query variants for a lead.
 *
 * Order (priority ascending — strongest evidence first):
 *   1  P.IVA exact (if vat_code is 11 digits)             — `piva`
 *   2  email-domain `site:` search                         — `email_domain`
 *   3  exact name + locality + exclusions                  — `exact_name`
 *   4  contact vector (intitle: + "contatti" / "chi siamo")— `contact`
 *   5  legal vector ("privacy policy" / "partita iva")     — `legal`
 *   6  phone vector ("name" "049...")                      — `phone`
 *   7  address vector ("name" "Via X" city)                — `address`
 *   8  "name city sito ufficiale" (exclusion-free)         — `official`
 *   9  "name city" ("contatti" OR "chi siamo")             — `fallback_contact`
 *
 * Returns `[]` when the company name is empty or reduces to stop-words
 * only — caller should fall back to a different stage rather than emit
 * a useless query.
 */
export function buildCompanyQueries(
  input: NormalizedLead,
  opts: BuildQueryOptions = {},
): QueryVariant[] {
  const variants: QueryVariant[] = [];
  const seen = new Set<string>();
  const exclusions = opts.omitExclusions ? '' : (opts.exclusionDorks ?? EXCLUSION_DORKS);
  const maxVariants = opts.maxVariants ?? 10;

  const cleanName = sanitizeForQuery(input.company_name);
  if (!cleanName || isOnlyStopWords(cleanName)) return variants;

  const cleanCity = sanitizeForQuery(input.city);
  const cleanProvince = sanitizeForQuery(input.province);
  const cleanAddress = sanitizeForQuery((input.address || '').split(',')[0] || '');
  const cleanPhone = (input.phone || '').replace(/\D/g, '');
  const locationHints = [cleanCity, cleanProvince].filter(Boolean);
  const locationQuery = locationHints.join(' ');
  const locationDorks = locationHints.map((h) => `"${h}"`).join(' ');

  const sanitizedNames = Array.from(
    new Set(
      (input.company_name_variants && input.company_name_variants.length > 0
        ? input.company_name_variants
        : [input.company_name]
      )
        .map((v) => sanitizeForQuery(v))
        .filter((v) => v && !isOnlyStopWords(v)),
    ),
  );
  const primaryName = sanitizedNames[0] || cleanName;

  // 1 — P.IVA exact (the GOD-TIER override). When the lead has an
  // 11-digit P.IVA, this query alone is usually enough to resolve it.
  // We add the exclusion list because some directories surface the
  // P.IVA as plain text on aggregator pages.
  if (input.vat_code) {
    const piva = input.vat_code.replace(/[^0-9]/g, '');
    if (piva.length === 11) {
      pushUnique(variants, seen, {
        query: `"${piva}" ${exclusions}`,
        vector: 'piva',
        priority: 1,
      });
    }
  }

  // 2 — email-domain site search. Strong because if the firm publishes
  // an email at @foosrl.com, their official site is almost certainly
  // foosrl.com or a subdomain.
  const emailDomain = resolveEmailDomain(input);
  if (emailDomain) {
    pushUnique(variants, seen, {
      query: `site:${emailDomain} "${primaryName}" ${locationQuery}`.trim(),
      vector: 'email_domain',
      priority: 2,
    });
  }

  // 3-5 — name-driven vectors, repeated across up to 3 name variants
  // (CSV-input variant + normalized variants). This catches the case
  // where the legal name and trading name differ.
  const namesToTry = sanitizedNames.slice(0, 3);
  for (const candidate of namesToTry) {
    // 3 — exact name + locality
    pushUnique(variants, seen, {
      query: locationDorks
        ? `"${candidate}" ${locationDorks} ${exclusions}`.trim()
        : `"${candidate}" ${exclusions}`.trim(),
      vector: 'exact_name',
      priority: 3,
    });

    // 4 — contact vector. `intitle:` + about/contact keywords proves
    // we're hitting a real company website rather than a directory
    // listing whose `<title>` is "Foo S.r.l. - PagineGialle".
    pushUnique(variants, seen, {
      query: locationDorks
        ? `intitle:"${candidate}" ("contatti" OR "chi siamo" OR "azienda") ${locationDorks} ${exclusions}`.trim()
        : `intitle:"${candidate}" ("contatti" OR "chi siamo" OR "azienda") ${exclusions}`.trim(),
      vector: 'contact',
      priority: 4,
    });

    // 5 — legal vector. Privacy/note-legali/partita-iva pages exist
    // on real company sites, almost never on directories.
    pushUnique(variants, seen, {
      query: locationDorks
        ? `"${candidate}" ${locationDorks} ("privacy policy" OR "note legali" OR "partita iva") ${exclusions}`.trim()
        : `"${candidate}" ("privacy policy" OR "note legali" OR "partita iva") ${exclusions}`.trim(),
      vector: 'legal',
      priority: 5,
    });
  }

  // 6 — phone vector. ≥8 digits after stripping non-numerics — covers
  // both Italian landlines (049 1234567) and mobiles (335 1234567).
  if (cleanPhone.length >= 8) {
    pushUnique(variants, seen, {
      query: `"${primaryName}" "${cleanPhone}" ${exclusions}`.trim(),
      vector: 'phone',
      priority: 6,
    });
  }

  // 7 — address vector. Only the street part, before the first comma.
  // ≥6 chars excludes useless tokens like "Via" alone.
  if (cleanAddress.length >= 6) {
    pushUnique(variants, seen, {
      query: locationQuery
        ? `"${primaryName}" "${cleanAddress}" ${locationQuery} ${exclusions}`.trim()
        : `"${primaryName}" "${cleanAddress}" ${exclusions}`.trim(),
      vector: 'address',
      priority: 7,
    });
  }

  // 8 — "sito ufficiale" fallback. Exclusion-free on purpose: this
  // is the variant that corroborates the others. If the only hit is
  // a paginegialle URL, the SerpDeduplicator drops it anyway.
  pushUnique(variants, seen, {
    query: locationQuery
      ? `"${primaryName}" ${locationQuery} sito ufficiale`.trim()
      : `"${primaryName}" sito ufficiale`.trim(),
    vector: 'official',
    priority: 8,
  });

  // 9 — contact fallback (also exclusion-free).
  pushUnique(variants, seen, {
    query: locationQuery
      ? `"${primaryName}" ${locationQuery} ("contatti" OR "chi siamo")`.trim()
      : `"${primaryName}" ("contatti" OR "chi siamo")`.trim(),
    vector: 'fallback_contact',
    priority: 9,
  });

  // Sort by priority, then the order they were added (stable). This
  // matters when the same vector appears multiple times across name
  // variants — we want them grouped.
  variants.sort((a, b) => a.priority - b.priority);
  return variants.slice(0, maxVariants);
}
