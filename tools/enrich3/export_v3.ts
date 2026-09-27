import fs from 'fs';
import path from 'path';
import { stringify } from 'csv-stringify/sync';
import { parseArgs, optString } from '../../src/cli/_args';
import type { Lead } from '../../src/types/lead';
import { loadState, runIfMain } from './_shared';
import { has } from '../../src/util/values';

/**
 * ENRICH-3 F — project the final state into the v3 delivery CSV: the EXACT
 * 21 v2 columns (same order, so every v2 consumer keeps working) + the new
 * columns whose fill-rate clears `--min-fill` (default 0.5% — an all-empty
 * column is noise, not capability). Row count and order are v2-identical;
 * freezing (sha256 + chmod 444 + MANIFEST) happens outside this script.
 *
 *   pnpm tsx tools/enrich3/export_v3.ts --state output/enrich3/state8.jsonl \
 *     --out output/enrich3/veneto_immobiliari_v3_<data>.csv
 */

/** The v2 delivery header, verbatim (DELIVERY/MANIFEST.md). NEVER reorder. */
export const V2_COLUMNS = [
  'company_name',
  'category',
  'city',
  'province',
  'address',
  'phone',
  'email_inferred',
  'email_type',
  'pec',
  'official_website',
  'website',
  'website_discovery_method',
  'vat_code_final',
  'revenue',
  'instagram',
  'facebook',
  'linkedin',
  'rating',
  'decision_maker_name',
  'lead_score',
  '_prov_query',
] as const;

/** New-column candidates, appended in this order when fill-rate > min-fill. */
export const CANDIDATE_COLUMNS = [
  'email_status',
  'reviews_count',
  'revenue_year',
  'employees',
  'share_capital',
  'legal_form',
  'ateco',
  'net_profit',
  'founding_year',
  'decision_maker_role',
  'tiktok',
  'youtube',
  'portal_source',
  'portal_listings_count',
  'portal_is_paid',
  'portal_fiaip',
] as const;

/** Share of leads (0..1) with `col` filled. */
function fillRate(leads: readonly Lead[], col: string): number {
  return leads.filter((l) => has((l as Record<string, unknown>)[col])).length / Math.max(1, leads.length);
}

/** Pure column selection: v2 header + candidates whose fill-rate clears minFill. */
export function chooseColumns(leads: Lead[], minFill: number): { columns: string[]; appended: string[] } {
  const appended = CANDIDATE_COLUMNS.filter((c) => fillRate(leads, c) > minFill);
  return { columns: [...V2_COLUMNS, ...appended], appended: [...appended] };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const statePath = optString(args, 'state') ?? 'output/enrich3/state8.jsonl';
  const out = optString(args, 'out');
  if (!out) throw new Error('--out <v3.csv> is required');
  const minFill = Number(optString(args, 'min-fill') ?? '0.005');

  const leads = await loadState(statePath);
  if (leads.length === 0) throw new Error('empty state');

  const { columns, appended } = chooseColumns(leads, minFill);

  const rows = leads.map((lead) => {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      const v = (lead as Record<string, unknown>)[col];
      row[col] = v === undefined || v === null ? '' : v;
    }
    return row;
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, stringify(rows, { header: true, columns: columns as unknown as string[] }));

  console.log(`export_v3: ${rows.length} righe → ${out}`);
  console.log(`colonne v2: ${V2_COLUMNS.length} · nuove incluse (fill > ${minFill * 100}%): ${appended.join(', ') || 'nessuna'}`);
  const excluded = CANDIDATE_COLUMNS.filter((c) => !appended.includes(c));
  if (excluded.length > 0) console.log(`escluse (fill ≤ soglia): ${excluded.join(', ')}`);
  for (const c of ['email_inferred', 'email_status', 'official_website', 'rating', 'revenue', 'employees', 'decision_maker_name', 'lead_score'] as const) {
    console.log(`  fill ${c}: ${(fillRate(leads, c as string) * 100).toFixed(1)}%`);
  }
  const leadTyped = leads as Lead[];
  const contactable = leadTyped.filter((l) => has(l.phone) || has(l.email_inferred)).length;
  console.log(`  contattabili (phone|email): ${contactable} (${((100 * contactable) / leads.length).toFixed(1)}%)`);
}

runIfMain('export_v3.ts', main);
