import fs from 'fs';
import type { Lead } from '../types/lead';
import { readCsvAsLeads } from './csv_reader';

/**
 * Reads lead files (CSV or JSONL, raw or enriched) for the analysis commands.
 * A row that fails to parse is skipped and counted, never half-loaded: a CSV
 * ingest error yields a lead with only `company_name`, which would inflate
 * every count it reached.
 */
export async function loadLeadFiles(inputs: readonly string[]): Promise<{ leads: Lead[]; skipped: number }> {
  const leads: Lead[] = [];
  let skipped = 0;
  for (const input of inputs) {
    if (!fs.existsSync(input)) throw new Error(`input not found: ${input}`);
    if (/\.jsonl$/i.test(input)) {
      for (const line of fs.readFileSync(input, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          leads.push(JSON.parse(t) as Lead);
        } catch {
          skipped += 1;
        }
      }
      continue;
    }
    for await (const { lead, ingestError } of readCsvAsLeads(input)) {
      if (ingestError) skipped += 1;
      else leads.push(lead);
    }
  }
  return { leads, skipped };
}
