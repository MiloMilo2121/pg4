import type { Lead } from '../types/lead';

/**
 * Maps a pg3 CSV row (any of the three known schemas — see Phase 3.7 §10)
 * to the canonical pg4 `Lead` shape. Unknown columns are preserved on the
 * catch-all index so nothing is silently lost.
 *
 * pg3-specific columns (`geriko_tier`, `score_total`, `score_negatives`)
 * are namespaced under `legacy_*` and ignored by the canonical pipeline.
 */

const ALIASES: Array<{ canonical: keyof Lead; aliases: string[] }> = [
  { canonical: 'company_name', aliases: ['company_name', 'name', 'ragione_sociale'] },
  { canonical: 'category', aliases: ['category', 'categoria'] },
  { canonical: 'city', aliases: ['city', 'locality', 'comune'] },
  { canonical: 'province', aliases: ['province', 'provincia', 'prov'] },
  { canonical: 'region', aliases: ['region', 'regione'] },
  { canonical: 'zip_code', aliases: ['zip_code', 'cap'] },
  { canonical: 'address', aliases: ['address', 'street', 'indirizzo'] },
  { canonical: 'phone', aliases: ['phone', 'telefono'] },
  { canonical: 'email', aliases: ['email', 'mail'] },
  { canonical: 'website', aliases: ['website', 'sito', 'url'] },
  { canonical: 'vat_code', aliases: ['vat_code', 'vat', 'piva', 'partita_iva'] },
  { canonical: 'pg_url', aliases: ['pg_url'] },
  { canonical: 'maps_url', aliases: ['maps_url'] },
  { canonical: 'source', aliases: ['source'] },
  { canonical: 'source_url', aliases: ['source_url'] },
  { canonical: 'pec', aliases: ['pec'] },
  { canonical: 'email_inferred', aliases: ['email_inferred'] },
  { canonical: 'email_type', aliases: ['email_type'] },
  { canonical: 'revenue', aliases: ['revenue'] },
  { canonical: 'revenue_year', aliases: ['revenue_year'] },
  { canonical: 'employees', aliases: ['employees'] },
  { canonical: 'employees_is_estimated', aliases: ['employees_is_estimated', 'is_estimated_employees'] },
  { canonical: 'decision_maker_name', aliases: ['decision_maker_name', 'dm_name', 'dm1_name'] },
  { canonical: 'decision_maker_role', aliases: ['decision_maker_role', 'dm_role', 'dm1_role'] },
  { canonical: 'decision_maker_linkedin', aliases: ['decision_maker_linkedin', 'dm_linkedin', 'dm1_linkedin'] },
  { canonical: 'discovery_notes', aliases: ['discovery_notes', 'notes'] },
  { canonical: 'query_location', aliases: ['query_location'] },
  { canonical: 'business_city', aliases: ['business_city'] },
];

/**
 * pg3-specific columns that we want to preserve under a `legacy_*` prefix
 * rather than discard. Keeps the round-trip auditable.
 */
const LEGACY_PRESERVE = new Set([
  'geriko_tier',
  'score_total',
  'score_negatives',
  'contact_source',
  'dm_confidence',
]);

const get = (row: Record<string, string>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && `${v}`.trim() !== '') return `${v}`.trim();
  }
  return undefined;
};

export function mapLegacyRow(row: Record<string, string>): Lead {
  const lead: Lead = { company_name: '' };

  for (const { canonical, aliases } of ALIASES) {
    const v = get(row, aliases);
    if (v === undefined) continue;
    if (canonical === 'employees_is_estimated') {
      lead.employees_is_estimated = /^(true|1|yes|y)$/i.test(v);
      continue;
    }
    (lead as Record<string, unknown>)[canonical] = v;
  }

  if (!lead.company_name) {
    throw new Error('mapLegacyRow: missing company_name');
  }

  // Preserve pg3-specific columns under legacy_*
  for (const [k, v] of Object.entries(row)) {
    if (!v) continue;
    if (LEGACY_PRESERVE.has(k)) {
      (lead as Record<string, unknown>)[`legacy_${k}`] = v;
    }
  }

  // Source provenance: ensure sources[] matches single-string source.
  if (lead.source && (!lead.sources || lead.sources.length === 0)) {
    // pg3 used `+` and `,` separators inconsistently
    lead.sources = String(lead.source)
      .split(/[+,/]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return lead;
}

/**
 * Convenience: read an entire pg3 CSV file via the canonical reader and
 * pass each row through `mapLegacyRow`. Caller is responsible for IO.
 */
export function mapLegacyRows(rows: Array<Record<string, string>>): Lead[] {
  const out: Lead[] = [];
  for (const row of rows) {
    try {
      out.push(mapLegacyRow(row));
    } catch {
      // Skip malformed rows; caller can count via array length diff.
    }
  }
  return out;
}
