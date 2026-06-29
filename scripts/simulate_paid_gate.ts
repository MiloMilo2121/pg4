import fs from 'node:fs';
import readline from 'node:readline';
import { request } from 'undici';
import { evaluatePaidEvidence } from '../src/discovery/website/paid_evidence_gate';
import { isDirectoryOrSocial } from '../src/discovery/website/content_filter';
import { DEFAULTS } from '../src/config/defaults';
import type { Lead } from '../src/types/lead';
import type { NormalizedLead } from '../src/types/discovery';

/**
 * R9 offline simulator — re-evaluates `SERP_PAID` accepted leads from
 * an enriched JSONL through the new PaidEvidenceGate. Free
 * (direct_fetch only), no Serper.
 *
 *   pnpm exec tsx pg4/scripts/simulate_paid_gate.ts <enriched.jsonl> [groundTruth.json]
 *
 * `groundTruth.json` (optional): { "<company_name>": "TP" | "FP" }.
 * Without it, the simulator only reports gate decisions (not
 * precision).
 */

interface Row {
  company_name: string;
  city?: string;
  province?: string;
  phone?: string;
  vat_code?: string;
  email?: string;
  email_domain?: string;
  official_website?: string;
  website_discovery_method?: string;
}

async function readJsonl(path: string): Promise<Row[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(path) });
  const rows: Row[] = [];
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t) as Row); } catch {/* skip */}
  }
  return rows;
}

async function fetchHtml(url: string): Promise<{ status: number; html?: string }> {
  try {
    const res = await request(url, {
      method: 'GET',
      bodyTimeout: DEFAULTS.pipeline.requestTimeoutMs,
      headersTimeout: DEFAULTS.pipeline.requestTimeoutMs,
      maxRedirections: 5,
      headers: {
        'user-agent': DEFAULTS.http.userAgent,
        'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      return { status: res.statusCode };
    }
    return { status: res.statusCode, html: await res.body.text() };
  } catch {
    return { status: 0 };
  }
}

function makeNorm(r: Row): NormalizedLead {
  return {
    company_name: r.company_name,
    company_name_variants: [r.company_name],
    city: r.city,
    province: r.province,
    phone: r.phone,
    vat_code: r.vat_code,
    email: r.email,
    email_domain: r.email_domain,
    quality_score: 0.5,
    raw: { company_name: r.company_name } as Lead,
  };
}

async function main() {
  const [enrichedPath, groundTruthPath] = process.argv.slice(2);
  if (!enrichedPath) {
    console.error('usage: simulate_paid_gate.ts <enriched.jsonl> [groundTruth.json]');
    process.exit(1);
  }
  const rows = await readJsonl(enrichedPath);
  const paidGains = rows.filter((r) => r.website_discovery_method === 'SERP_PAID');
  console.log(`# Simulation on ${enrichedPath}`);
  console.log(`SERP_PAID rows: ${paidGains.length}`);
  console.log('');

  const truth: Record<string, 'TP' | 'FP'> = groundTruthPath
    ? JSON.parse(fs.readFileSync(groundTruthPath, 'utf8'))
    : {};

  let allowed = 0;
  let rejected = 0;
  let tpKept = 0;
  let tpLost = 0;
  let fpKept = 0;
  let fpCaught = 0;
  const lostTpRows: Row[] = [];
  const keptFpRows: Row[] = [];

  let directoryFiltered = 0;
  for (const r of paidGains) {
    const url = r.official_website ?? '';
    if (!url) continue;
    // R9 — apply the directory blocklist BEFORE the gate, mirroring
    // production flow (`verifyCandidates` rejects directory hosts at
    // entry). This includes the R8.1.VR hardening additions.
    if (isDirectoryOrSocial(url)) {
      directoryFiltered += 1;
      rejected += 1;
      if (truth[r.company_name] === 'TP') { tpLost += 1; lostTpRows.push(r); }
      else if (truth[r.company_name] === 'FP') fpCaught += 1;
      continue;
    }
    const res = await fetchHtml(url);
    if (!res.html) {
      console.log(`fetch_fail status=${res.status} url=${url}`);
      // Skip — can't decide without body. Treat as REJECT for safety.
      rejected += 1;
      if (truth[r.company_name] === 'TP') { tpLost += 1; lostTpRows.push(r); }
      else if (truth[r.company_name] === 'FP') { fpCaught += 1; }
      continue;
    }
    const verdict = evaluatePaidEvidence(res.html, makeNorm(r), { company_name: r.company_name });
    if (verdict.allow) {
      allowed += 1;
      if (truth[r.company_name] === 'TP') tpKept += 1;
      else if (truth[r.company_name] === 'FP') { fpKept += 1; keptFpRows.push(r); }
    } else {
      rejected += 1;
      if (truth[r.company_name] === 'TP') { tpLost += 1; lostTpRows.push(r); }
      else if (truth[r.company_name] === 'FP') fpCaught += 1;
    }
  }

  console.log('## Combined outcome (directory filter + gate)');
  console.log(`  allowed:           ${allowed}`);
  console.log(`  rejected:          ${rejected}`);
  console.log(`    of which by directory filter: ${directoryFiltered}`);

  if (groundTruthPath) {
    const totalTp = tpKept + tpLost;
    const totalFp = fpKept + fpCaught;
    const newPrecision = allowed > 0 ? tpKept / allowed : 0;
    const tpRecall = totalTp > 0 ? tpKept / totalTp : 0;
    console.log('');
    console.log('## Vs ground truth');
    console.log(`  total labelled:   TP=${totalTp}  FP=${totalFp}`);
    console.log(`  tp kept:          ${tpKept}`);
    console.log(`  tp lost:          ${tpLost}`);
    console.log(`  fp caught:        ${fpCaught}`);
    console.log(`  fp kept:          ${fpKept}`);
    console.log(`  new precision:    ${(newPrecision * 100).toFixed(1)} %`);
    console.log(`  tp recall:        ${(tpRecall * 100).toFixed(1)} %`);
    if (lostTpRows.length > 0) {
      console.log('');
      console.log('### TPs LOST (under new gate)');
      for (const r of lostTpRows) console.log(`  - ${r.company_name} → ${r.official_website}`);
    }
    if (keptFpRows.length > 0) {
      console.log('');
      console.log('### FPs still ACCEPTED (residual)');
      for (const r of keptFpRows) console.log(`  - ${r.company_name} → ${r.official_website}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
