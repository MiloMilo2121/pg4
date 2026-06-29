/**
 * Phase 1 (free-gold) — measurement probe. READ-ONLY, FREE.
 *
 * Quantifies the free-gold thesis: on leads that already have an
 * `official_website` (so pg4 already paid €0 to fetch it for verification),
 * how often does `extractFromBody` recover email / PEC / social / VAT from
 * that same page? Re-fetches a sample via direct_fetch (tier-0, cost 0) and
 * tallies hit-rates. Prints a table; writes nothing.
 *
 * Usage:
 *   pnpm exec tsx src/scripts/probe_free_gold.ts [--input <enriched.jsonl>] [--n 200]
 * Default input: output/r12_maps_pd_province_full_enriched_free.jsonl
 *
 * Thesis PASS bar (on website-having leads): email ≥40% · any-social ≥50% ·
 * VAT-from-body ≥30%. (Reported honestly — never adjusted to clear the bar.)
 */
import fs from 'fs';
import { parseArgs, optString } from '../cli/_args';
import { DirectFetchProvider } from '../providers/http/direct_fetch';
import { extractFromBody } from '../enrichment/extract/extract_from_body';

interface ProbeLead {
  company_name?: string;
  official_website?: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const input = optString(args, 'input') ?? 'output/r12_maps_pd_province_full_enriched_free.jsonl';
  const n = Number(optString(args, 'n') ?? '200');

  if (!fs.existsSync(input)) {
    process.stderr.write(`[probe] input not found: ${input}\n`);
    process.exit(2);
  }

  const rows: ProbeLead[] = fs
    .readFileSync(input, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ProbeLead)
    .filter((r) => r.official_website && /^https?:\/\//.test(r.official_website));

  // Even sampling across the file (not just the head).
  const step = Math.max(1, Math.floor(rows.length / n));
  const sample = rows.filter((_r, i) => i % step === 0).slice(0, n);

  const fetcher = new DirectFetchProvider();
  const tally = { email: 0, pec: 0, instagram: 0, facebook: 0, linkedin: 0, anySocial: 0, vat: 0, extraPhone: 0 };
  let fetched = 0;
  let failed = 0;

  process.stderr.write(`[probe] ${sample.length} sites (of ${rows.length} with website) from ${input}\n`);
  for (const r of sample) {
    let html: string | undefined;
    try {
      const res = await fetcher.fetch(r.official_website!, { timeoutMs: 8000 });
      html = res.html;
    } catch {
      /* counted as failed below */
    }
    if (!html) {
      failed += 1;
      continue;
    }
    fetched += 1;
    const ex = extractFromBody(html, { official_website: r.official_website });
    if (ex.email) tally.email += 1;
    if (ex.pec) tally.pec += 1;
    if (ex.instagram) tally.instagram += 1;
    if (ex.facebook) tally.facebook += 1;
    if (ex.linkedin) tally.linkedin += 1;
    if (ex.instagram || ex.facebook || ex.linkedin) tally.anySocial += 1;
    if (ex.vat_candidates.length > 0) tally.vat += 1;
    if (ex.phones.length > 0) tally.extraPhone += 1;
  }

  const pct = (x: number): string => (fetched > 0 ? `${((100 * x) / fetched).toFixed(1)}%` : 'n/a');
  const out = {
    input,
    sampled: sample.length,
    fetched,
    fetch_failed: failed,
    hit_rates: {
      email: pct(tally.email),
      pec: pct(tally.pec),
      any_social: pct(tally.anySocial),
      instagram: pct(tally.instagram),
      facebook: pct(tally.facebook),
      linkedin: pct(tally.linkedin),
      vat_from_body: pct(tally.vat),
      extra_phone: pct(tally.extraPhone),
    },
    cost_eur: 0,
    thesis_pass: {
      email_ge_40: fetched > 0 && (100 * tally.email) / fetched >= 40,
      any_social_ge_50: fetched > 0 && (100 * tally.anySocial) / fetched >= 50,
      vat_from_body_ge_30: fetched > 0 && (100 * tally.vat) / fetched >= 30,
    },
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[probe] ${(err as Error).message}\n`);
  process.exit(1);
});
