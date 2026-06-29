/**
 * consolidate_leads.ts — unify + dedup EVERY lead we have (pg1/pg3/pg4) into one
 * canonical master, reusing pg4's own primitives. NON-DESTRUCTIVE by contract:
 * it only READS the historical files and WRITES new ones under `pg4/leads/`.
 * It never deletes or moves a source file.
 *
 * Reuse (no new dedup logic):
 *   - readCsvAsLeads  — tolerant column mapping (pg1/pg3 aliases) + passthrough
 *                       of any extra column (pec, employees, linkedin, geriko_tier…).
 *   - readJsonlAsLeads — for pg4 enriched JSONL outputs.
 *   - Deduplicator    — the franchise-safe phone/name/host/vat dedup (find/merge/add).
 *   - CsvWriter / JsonlWriter — the canonical output writers.
 *
 * Output (all gitignored — PII):
 *   leads/_MASTER/all_leads_master.jsonl   (lossless: every field, sources[] union)
 *   leads/_MASTER/all_leads_master.csv     (enriched schema, human-readable)
 *   leads/_MASTER/consolidation_report.json
 *
 * Run from pg4/:  pnpm tsx src/scripts/consolidate_leads.ts
 */
import fs from 'fs';
import path from 'path';
import { readCsvAsLeads } from '../io/csv_reader';
import { readJsonlAsLeads } from '../io/jsonl_writer';
import { CsvWriter } from '../io/csv_writer';
import { JsonlWriter } from '../io/jsonl_writer';
import { Deduplicator } from '../discovery/deduper';
import type { Lead } from '../types/lead';

const PG4 = process.cwd();
const REPO_ROOT = path.resolve(PG4, '..'); // contains pg1/ pg3/ pg4/
const OUT_DIR = path.join(PG4, 'leads', '_MASTER');

// Dirs we never descend into (regenerable junk / not lead data).
const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'testenv', 'temp_profiles', 'search_profile_scraper',
  'logs', '.next', 'coverage', '.turbo', 'leads',
  // synthetic / non-production data — never merge into the real lead master:
  'tests', 'test', 'examples', 'fixtures', '__fixtures__', 'e2e_samples',
  'dropcontact_tests', '__pycache__', 'golden',
]);
// Files that look like data but are NOT real leads (ledgers, benchmarks, synthetic samples).
const NON_LEAD =
  /cost_ledger|_ledger|benchmark|healthcheck|provider.?health|\.log\.|sample|interrupt_test|expected_|mock|fixture|baseline|_seed|golden/i;

function walk(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, acc);
    } else if (e.isFile()) {
      if (NON_LEAD.test(e.name)) continue;
      if (/\.(csv|jsonl)$/i.test(e.name)) acc.push(full);
    }
  }
  return acc;
}

/** Heuristic: which client/source does this file belong to (for the breakdown). */
function classifyClient(relPath: string): string {
  const p = relPath.toUpperCase();
  if (p.includes('GERIKO')) return 'GERIKO';
  if (/PG4\//i.test(relPath) || relPath.startsWith('pg4/')) return 'PG4_CURRENT';
  if (/R12|MAPS_PD|PROVINCE|PADOVA|\bPD\b/.test(p)) return 'PG4_PADOVA';
  return 'OTHER';
}

async function loadLeads(file: string): Promise<{ leads: Lead[]; ingestErrors: number }> {
  const leads: Lead[] = [];
  let ingestErrors = 0;
  if (/\.jsonl$/i.test(file)) {
    try {
      const arr = await readJsonlAsLeads(file);
      for (const l of arr) if (l && l.company_name) leads.push(l);
    } catch {
      ingestErrors++;
    }
    return { leads, ingestErrors };
  }
  // CSV
  try {
    for await (const { lead, ingestError } of readCsvAsLeads(file)) {
      if (ingestError || !lead.company_name || lead.company_name.trim() === '') {
        ingestErrors++;
        continue;
      }
      leads.push(lead);
    }
  } catch {
    ingestErrors++;
  }
  return { leads, ingestErrors };
}

async function main() {
  console.log(`[consolidate] repo root: ${REPO_ROOT}`);
  const candidates = walk(REPO_ROOT).map((f) => path.relative(REPO_ROOT, f)).sort();
  console.log(`[consolidate] candidate lead files: ${candidates.length}`);

  const dedup = new Deduplicator();
  const unique: Lead[] = [];

  let grossRows = 0;
  let ingestErrorsTotal = 0;
  const perFile: Array<{ file: string; client: string; rows: number; errors: number }> = [];
  const grossByClient: Record<string, number> = {};

  for (const rel of candidates) {
    const abs = path.join(REPO_ROOT, rel);
    const client = classifyClient(rel);
    const { leads, ingestErrors } = await loadLeads(abs);
    ingestErrorsTotal += ingestErrors;
    if (leads.length === 0 && ingestErrors === 0) continue; // empty file, skip from report noise
    grossRows += leads.length;
    grossByClient[client] = (grossByClient[client] ?? 0) + leads.length;
    perFile.push({ file: rel, client, rows: leads.length, errors: ingestErrors });

    for (const lead of leads) {
      // Stamp provenance of the originating file (passthrough; preserved in JSONL).
      (lead as Record<string, unknown>)._origin_file = rel;
      (lead as Record<string, unknown>)._origin_client = client;
      const existing = dedup.find(lead);
      if (existing) {
        dedup.merge(existing, lead);
      } else {
        dedup.add(lead);
        unique.push(lead);
      }
    }
  }

  // Per-client UNIQUE breakdown (a company can carry one origin client; first-seen wins).
  const uniqueByClient: Record<string, number> = {};
  for (const l of unique) {
    const c = String((l as Record<string, unknown>)._origin_client ?? 'OTHER');
    uniqueByClient[c] = (uniqueByClient[c] ?? 0) + 1;
  }

  // Field fill on the unique master (how rich the merged corpus is).
  const fill = (pred: (l: Lead) => boolean) => unique.filter(pred).length;
  const fillRates = {
    phone: fill((l) => !!l.phone),
    email: fill((l) => !!l.email),
    website: fill((l) => !!l.website),
    vat_code: fill((l) => !!l.vat_code),
    pec: fill((l) => !!(l as Record<string, unknown>).pec),
    address: fill((l) => !!l.address),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Write lossless JSONL master.
  const jsonlPath = path.join(OUT_DIR, 'all_leads_master.jsonl');
  const jw = new JsonlWriter(jsonlPath);
  for (const l of unique) await jw.write(l);
  await jw.close();

  // Write human-readable enriched CSV master.
  const csvPath = path.join(OUT_DIR, 'all_leads_master.csv');
  const cw = new CsvWriter(csvPath, 'enriched');
  for (const l of unique) await cw.write(l);
  await cw.close();

  // --- ORGANIZE (non-destructive): COPY each source lead file into
  // leads/_SOURCES/<client>/, preserving a unique name. Originals are never
  // moved or deleted — this only gathers copies into one tidy place. ---
  const SRC_DIR = path.join(PG4, 'leads', '_SOURCES');
  let copied = 0;
  for (const { file, client } of perFile) {
    const destDir = path.join(SRC_DIR, client);
    fs.mkdirSync(destDir, { recursive: true });
    const base = path.basename(file);
    let dest = path.join(destDir, base);
    if (fs.existsSync(dest)) {
      // collision → prefix with the immediate parent dir to disambiguate.
      const parent = path.basename(path.dirname(file));
      dest = path.join(destDir, `${parent}__${base}`);
    }
    try {
      fs.copyFileSync(path.join(REPO_ROOT, file), dest);
      copied++;
    } catch {
      /* unreadable source — skip, original untouched */
    }
  }
  console.log(`[organize] copied ${copied} source files into leads/_SOURCES/<client>/ (originals untouched)`);

  const reviewCandidates = dedup.getReviewCandidates();
  const report = {
    generated_from: REPO_ROOT,
    files_scanned: candidates.length,
    files_with_leads: perFile.length,
    gross_rows: grossRows,
    unique_companies: unique.length,
    duplicates_collapsed: grossRows - unique.length,
    dedup_ratio: grossRows > 0 ? +(1 - unique.length / grossRows).toFixed(3) : 0,
    ingest_errors: ingestErrorsTotal,
    near_duplicate_review_candidates: reviewCandidates.length,
    gross_by_client: grossByClient,
    unique_by_client: uniqueByClient,
    fill_counts: fillRates,
    per_file: perFile.sort((a, b) => b.rows - a.rows),
    outputs: { jsonl: path.relative(PG4, jsonlPath), csv: path.relative(PG4, csvPath) },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'consolidation_report.json'), JSON.stringify(report, null, 2));

  // Console summary.
  console.log('\n========== LEAD CONSOLIDATION ==========');
  console.log(`files with leads : ${perFile.length} / ${candidates.length} scanned`);
  console.log(`gross rows       : ${grossRows}`);
  console.log(`unique companies : ${unique.length}`);
  console.log(`dupes collapsed  : ${grossRows - unique.length}  (${(report.dedup_ratio * 100).toFixed(1)}%)`);
  console.log(`ingest errors    : ${ingestErrorsTotal}`);
  console.log(`review (near-dup): ${reviewCandidates.length}`);
  console.log('\n-- unique by client --');
  for (const [c, n] of Object.entries(uniqueByClient).sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(14)} ${n}`);
  console.log('\n-- fill on master --');
  for (const [f, n] of Object.entries(fillRates)) console.log(`  ${f.padEnd(10)} ${n}  (${((n / Math.max(1, unique.length)) * 100).toFixed(0)}%)`);
  console.log('\n-- top source files --');
  for (const r of report.per_file.slice(0, 12)) console.log(`  ${String(r.rows).padStart(6)}  ${r.client.padEnd(13)} ${r.file}`);
  console.log(`\nmaster written:\n  ${jsonlPath}\n  ${csvPath}`);
  console.log('========================================\n');
}

main().catch((e) => {
  console.error('[consolidate] FATAL', e);
  process.exit(1);
});
