/**
 * The owner's 10-row fatturato source-check, automated against the LIVE page's OWN
 * stated headline. For each company with fatturato across the 3 audit samples:
 * fetch fatturatoitalia today, read the PAGE'S own meta/title headline ("fatturato
 * X € (YEAR)") — what a human sees — and compare to what the PIPELINE reported.
 * Match = the pipeline agrees with the source's own number + confirms max-year on
 * live data. Rate-limited (4.5s). €0.
 */
import fs from 'fs';
import { DirectFetchProvider } from '../providers/http/direct_fetch';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function eur(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const d = s.replace(/[^\d]/g, '');
  return d ? Number(d) : undefined;
}

async function main(): Promise<void> {
  const pool: any[] = [];
  for (const lbl of ['S1', 'S2', 'S3']) {
    const a = JSON.parse(fs.readFileSync(`docs/precision_evidence/audit_${lbl}.json`, 'utf8'));
    for (const c of a.companies) {
      if (c.fatturato?.revenue && c.fatturato?.vat) pool.push({ co: c.company_name, vat: c.fatturato.vat, pipe_rev: c.fatturato.revenue, pipe_year: c.fatturato.revenue_year, emp: c.cells.employees.value });
    }
  }
  const f = new DirectFetchProvider();
  const rows = pool.slice(0, 10);
  let pass = 0;
  const results: any[] = [];
  for (const r of rows) {
    let html = '';
    try { html = (await f.fetch(`https://www.fatturatoitalia.it/${r.vat}`, { timeoutMs: 15000 })).html ?? ''; } catch {}
    // the page's OWN headline (what a human reads): meta description + title year
    const md = html.match(/fatturato\s*([\d.]+)\s*€[^(]*\((\d{4})\)/i);
    const titleYear = (html.match(/<title>[^<]*\((\d{4})\)/i) || [])[1];
    const pageRev = md ? eur(md[1]) : undefined;
    const pageYear = md ? md[2] : titleYear;
    // employees shown on page (band text), to verify the "10-15"/"1" parses
    const empPage = (html.match(/(\d+\s*-\s*\d+|da\s*\d+\s*a\s*\d+|oltre\s*\d+|fino\s*a\s*\d+)\s*(?:dipendent)/i) || [])[1];
    const pipeRev = eur(r.pipe_rev);
    const revMatch = pageRev !== undefined && pipeRev !== undefined && pageRev === pipeRev;
    const yearMatch = String(pageYear) === String(r.pipe_year);
    const ok = revMatch && yearMatch;
    if (ok) pass++;
    results.push({ co: r.co.slice(0, 30), vat: r.vat, pipeline: `${r.pipe_rev} (${r.pipe_year})`, page: pageRev !== undefined ? `€ ${pageRev.toLocaleString('it-IT')} (${pageYear})` : 'NO-HEADLINE', emp_pipe: r.emp, emp_page: empPage, MATCH: ok });
    await sleep(4500);
  }
  console.log(`=== 10-ROW FATTURATO SOURCE CHECK: ${pass}/${rows.length} match the page's own headline ===`);
  for (const r of results) console.log(`${r.MATCH ? 'OK ' : 'XX '} ${r.co.padEnd(31)} pipe=${String(r.pipeline).padEnd(22)} page=${String(r.page).padEnd(22)} emp pipe=${r.emp_pipe ?? '-'}/page=${r.emp_page ?? '-'}`);
  fs.writeFileSync('docs/precision_evidence/audit_10row_check.json', JSON.stringify({ pass, total: rows.length, results }, null, 2));
}
void main();
