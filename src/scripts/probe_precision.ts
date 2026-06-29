/**
 * Phase A.2 — PRECISION probe. READ-ONLY, FREE.
 *
 * FILL-RATE = a field got populated. PRECISION = the populated value is the
 * COMPANY'S OWN, correct value. The two bugs (wrong-year revenue, mangled
 * employee bands) were both fill-rate-fine / precision-broken. This measures
 * precision against the source, per field, as a repeatable artifact — the
 * lesson of the project made systematic.
 *
 * Heuristics (each is a PROXY for precision, stated honestly):
 *  - email:  is the extracted address on the company's OWN registrable domain?
 *            (a dev's/partner's address lives on a different domain). The
 *            extractor already enforces same-domain, so this confirms it holds
 *            + flags role/generic addresses for an eyeball.
 *  - vat:    VIES the footer VAT → does the OFFICIAL name returned match the
 *            company name? Match ⇒ the VAT is the company's own (precise);
 *            mismatch ⇒ it's someone else's (accountant/partner) cited in the
 *            footer (imprecise). VIES with no name ⇒ can't auto-verify (flagged).
 *  - social: is the URL a real profile (handle path), not a platform root /
 *            share / embed? (ownership needs an eyeball — flagged).
 *
 * Usage: pnpm exec tsx src/scripts/probe_precision.ts [--input <jsonl>] [--n 24]
 */
import fs from 'fs';
import path from 'path';
import { parseArgs, optString } from '../cli/_args';
import { DirectFetchProvider } from '../providers/http/direct_fetch';
import { extractFromBody, registrableDomain } from '../enrichment/extract/extract_from_body';
import { checkVatViaVies } from '../enrichment/financial/vies';
import { normalizeCompanyNameForKey } from '../discovery/deduper';

interface Row { company_name?: string; official_website?: string }

/** Fuzzy company-name match: token overlap after legal-form normalization. */
function nameMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ta = new Set(normalizeCompanyNameForKey(a).split(' ').filter((t) => t.length > 2));
  const tb = new Set(normalizeCompanyNameForKey(b).split(' ').filter((t) => t.length > 2));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.min(ta.size, tb.size) >= 0.5;
}

const ROLE_LOCALPARTS = /^(info|contatti|amministrazione|segreteria|commerciale|vendite|ufficio|mail|posta|staff)\b/;

async function main(): Promise<void> {
  const args = parseArgs();
  const input = optString(args, 'input') ?? 'output/r12_maps_pd_province_full_enriched_free.jsonl';
  const n = Number(optString(args, 'n') ?? '24');
  if (!fs.existsSync(path.resolve(input))) {
    process.stderr.write(`[precision] input not found: ${input}\n`);
    process.exit(2);
  }
  const rows: Row[] = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row)
    .filter((r) => r.official_website && /^https?:\/\//.test(r.official_website));
  const step = Math.max(1, Math.floor(rows.length / n));
  const sample = rows.filter((_r, i) => i % step === 0).slice(0, n);

  const fetcher = new DirectFetchProvider();
  const samples: unknown[] = [];
  let sites = 0;
  const email = { filled: 0, sameDomain: 0, role: 0 };
  const vat = { filled: 0, viesNameMatch: 0, viesMismatch: 0, viesNoName: 0 };
  const social = { filled: 0, profileShaped: 0 };

  process.stderr.write(`[precision] ${sample.length} sites from ${input}\n`);
  for (const r of sample) {
    let html: string | undefined;
    try { html = (await fetcher.fetch(r.official_website!, { timeoutMs: 8000 })).html; } catch { /* skip */ }
    if (!html) continue;
    sites += 1;
    const ex = extractFromBody(html, { official_website: r.official_website });
    const own = registrableDomain(r.official_website);
    const rec: Record<string, unknown> = { company: r.company_name, site: own };

    if (ex.email) {
      email.filled += 1;
      const emailDom = registrableDomain(ex.email.split('@')[1]);
      const same = emailDom === own;
      if (same) email.sameDomain += 1;
      const role = ROLE_LOCALPARTS.test(ex.email.split('@')[0]);
      if (role) email.role += 1;
      rec.email = { value: ex.email, same_domain: same, role };
    }
    if (ex.instagram || ex.facebook || ex.linkedin) {
      social.filled += 1;
      const url = ex.instagram ?? ex.facebook ?? ex.linkedin!;
      const profile = /\.(com)\/[A-Za-z0-9._\-]{2,}/.test(url) && !/\/(sharer|share|plugins|intent)\b/.test(url);
      if (profile) social.profileShaped += 1;
      rec.social = { value: url, profile_shaped: profile };
    }
    if (ex.vat_candidates[0]) {
      vat.filled += 1;
      const v = await checkVatViaVies({ vatNumber: ex.vat_candidates[0], countryCode: 'IT' }).catch(() => undefined);
      const viesName = v?.name && !/^[-\s]*$/.test(v.name) ? v.name : undefined;
      let verdict: string;
      if (!viesName) { vat.viesNoName += 1; verdict = 'vies_no_name'; }
      else if (nameMatches(viesName, r.company_name)) { vat.viesNameMatch += 1; verdict = 'match'; }
      else { vat.viesMismatch += 1; verdict = 'MISMATCH'; }
      rec.vat = { value: ex.vat_candidates[0], vies_name: viesName ?? null, verdict };
    }
    samples.push(rec);
  }

  const pc = (x: number, d: number): string => (d > 0 ? `${((100 * x) / d).toFixed(1)}%` : 'n/a');
  const report = {
    input, sites_fetched: sites,
    email: {
      fill_rate: `${email.filled}/${sites} (${pc(email.filled, sites)})`,
      precision_same_domain: `${email.sameDomain}/${email.filled} (${pc(email.sameDomain, email.filled)})`,
      role_or_generic: `${email.role}/${email.filled} (${pc(email.role, email.filled)}) — company-owned but not a person`,
    },
    vat: {
      fill_rate: `${vat.filled}/${sites} (${pc(vat.filled, sites)})`,
      precision_vies_name_match: `${vat.viesNameMatch}/${vat.filled - vat.viesNoName} verifiable (${pc(vat.viesNameMatch, vat.filled - vat.viesNoName)})`,
      mismatch_wrong_company: `${vat.viesMismatch}`,
      vies_no_name_unverifiable: `${vat.viesNoName}`,
    },
    social: {
      fill_rate: `${social.filled}/${sites} (${pc(social.filled, sites)})`,
      precision_profile_shaped: `${social.profileShaped}/${social.filled} (${pc(social.profileShaped, social.filled)}) — ownership needs eyeball`,
    },
    cost_eur: 0,
  };
  process.stdout.write(JSON.stringify({ report, samples }, null, 2) + '\n');
}

main().catch((e) => { process.stderr.write(`[precision] ${(e as Error).message}\n`); process.exit(1); });
