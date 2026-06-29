import fs from 'fs';
import { parse } from 'csv-parse';
import type { Lead } from '../types/lead';

/**
 * Stream CSV rows as Lead objects. Caller iterates with `for await ...`.
 * Errors on bad rows are NOT fatal — they yield a Lead with a parse marker
 * so the enricher can produce an output row with reason_code=ERROR_INVALID_INPUT_ROW.
 */
export async function* readCsvAsLeads(path: string): AsyncIterable<{ lead: Lead; lineNumber: number; ingestError?: string }> {
  if (!fs.existsSync(path)) {
    throw new Error(`CSV input not found: ${path}`);
  }
  const stream = fs.createReadStream(path);
  const parser = stream.pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
    })
  );

  let lineNumber = 1; // header is line 1
  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    lineNumber += 1;
    try {
      const lead = rowToLead(row);
      yield { lead, lineNumber };
    } catch (e) {
      yield { lead: { company_name: row.company_name ?? '' }, lineNumber, ingestError: (e as Error).message };
    }
  }
}

function rowToLead(row: Record<string, string>): Lead {
  // Tolerant column mapping: accept aliases pg1/pg3 used historically.
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && `${v}`.trim() !== '') return `${v}`.trim();
    }
    return undefined;
  };

  const lead: Lead = { company_name: get('company_name', 'name', 'ragione_sociale') ?? '' };
  if (!lead.company_name) throw new Error('Missing company_name');

  lead.category = get('category', 'categoria');
  lead.city = get('city', 'locality', 'comune');
  lead.province = get('province', 'provincia', 'prov');
  lead.region = get('region', 'regione');
  lead.zip_code = get('zip_code', 'cap');
  lead.address = get('address', 'street', 'indirizzo');
  lead.phone = get('phone', 'telefono');
  lead.email = get('email', 'mail');
  lead.website = get('website', 'sito', 'url');
  lead.vat_code = get('vat_code', 'vat', 'piva', 'partita_iva');
  lead.source = get('source');
  lead.source_url = get('source_url');
  lead.pg_url = get('pg_url');
  lead.maps_url = get('maps_url');
  lead.discovery_notes = get('discovery_notes', 'notes');
  const conf = get('confidence');
  if (conf) {
    const n = Number(conf);
    if (!Number.isNaN(n)) lead.confidence = n;
  }

  // Preserve any other columns under a passthrough key
  for (const [k, v] of Object.entries(row)) {
    if (!(k in lead) && v !== undefined && v !== '') {
      lead[k] = v;
    }
  }

  return lead;
}
