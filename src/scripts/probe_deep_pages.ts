/**
 * B.1 precision+fill probe — measure the deep-pages email LIFT against the source.
 *
 * For a real sample: email fill from the HOMEPAGE ONLY vs the DEEPENED extraction
 * (homepage + contact/about pages). Reports the fill lift AND verifies the lifted
 * emails are still same-domain (precision preserved, never traded for fill).
 *
 *   pnpm exec tsx src/scripts/probe_deep_pages.ts --n 30 [--step 7]
 *
 * Output → docs/precision_evidence/probe_deep_pages_output.json. €0 (HTTP only).
 */
import fs from 'fs';
import path from 'path';
import { DirectFetchProvider } from '../providers/http/direct_fetch';
import { extractFromBody, registrableDomain } from '../enrichment/extract/extract_from_body';
import { deepExtractFromSite } from '../enrichment/extract/deep_pages';

const SEED = 'output/r12_maps_pd_province_full_enriched_free.jsonl';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

async function main(): Promise<void> {
  const n = arg('--n', 30);
  const step = arg('--step', 7);
  const fetcher = new DirectFetchProvider();
  const fetch = async (url: string): Promise<string | undefined> => {
    try {
      return (await fetcher.fetch(url, { timeoutMs: 8000 })).html;
    } catch {
      return undefined;
    }
  };

  const rows = fs
    .readFileSync(SEED, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s))
    .filter((r) => r.official_website);

  let sites = 0;
  let homeFill = 0;
  let deepFill = 0;
  let lifted = 0;
  let liftedSameDomain = 0;
  let extraPages = 0;
  const liftSamples: Array<{ company: string; site: string; email: string; sameDomain: boolean; pages: number }> = [];

  for (let i = 0; i < rows.length && sites < n; i += step) {
    const r = rows[i];
    const site = String(r.official_website);
    const home = await fetch(site);
    if (!home) continue;
    sites += 1;
    const emailHome = extractFromBody(home, { official_website: site }).email;
    const deep = await deepExtractFromSite(site, fetch);
    const emailDeep = deep.extraction.email;
    extraPages += Math.max(0, deep.pagesFetched.length - 1);
    if (emailHome) homeFill += 1;
    if (emailDeep) deepFill += 1;
    if (!emailHome && emailDeep) {
      lifted += 1;
      const own = registrableDomain(site);
      const dom = registrableDomain(emailDeep.split('@')[1]);
      const same = !!own && dom === own;
      if (same) liftedSameDomain += 1;
      liftSamples.push({ company: String(r.company_name ?? '').slice(0, 40), site, email: emailDeep, sameDomain: same, pages: deep.pagesFetched.length });
    }
  }

  const pct = (x: number, d: number): string => (d ? `${((100 * x) / d).toFixed(1)}%` : 'n/a');
  const out = {
    sample: sites,
    email_fill_homepage_only: { count: homeFill, pct: pct(homeFill, sites) },
    email_fill_deepened: { count: deepFill, pct: pct(deepFill, sites) },
    lift: { newly_filled: lifted, of_sample: pct(lifted, sites) },
    lift_precision: { same_domain: liftedSameDomain, of_lifted: pct(liftedSameDomain, lifted), note: 'lifted emails that stayed on the firm own registrable domain (precision preserved)' },
    cost: { extra_contact_page_fetches_total: extraPages, avg_per_site: sites ? (extraPages / sites).toFixed(2) : '0', eur: 0 },
    lift_samples: liftSamples,
  };
  const dest = path.resolve('docs/precision_evidence/probe_deep_pages_output.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.error(`\nwrote ${dest}`);
}

void main();
