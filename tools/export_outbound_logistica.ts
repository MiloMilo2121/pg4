import fs from 'fs';
import path from 'path';
import { stringify } from 'csv-stringify/sync';
import { parseArgs, optString } from '../src/cli/_args';
import type { Lead } from '../src/types/lead';
import { readJsonlAsLeads } from '../src/io/jsonl_writer';
import { runIfMain } from './enrich3/_shared';

/**
 * Export OUTBOUND per il segmento autotrasporto/logistica — proietta i raw
 * JSONL delle celle (slug×provincia) nel CSV unico del brief di sourcing:
 * UTF-8, delimitatore ';', campi GREZZI (telefono_raw non normalizzato),
 * `scraped_at` ISO dall'mtime del file sorgente.
 *
 * Regole del brief, implementate ALLA LETTERA:
 *   - esclusioni: record senza telefono; categorie chiaramente fuori target
 *     (taxi/NCC/trasporto persone/traslochi/autoscuole — rilevate sui token
 *     della ragione sociale, perché la categoria del record È la nostra query)
 *   - dedup SOLO esatto su telefono_1+comune (cifre + comune lowercase);
 *     stessa azienda in più categorie → un record, categorie concatenate
 *     con ' | ' e riempimento solo-campi-vuoti (mai sovrascrittura)
 *   - niente normalizzazione telefoni, niente arricchimento esterno
 *
 * telefono_2 resta vuoto: le card-lista PG espongono un solo numero (il
 * parser tiene il primo per contratto); il campo è nel layout per stabilità
 * dello schema a valle.
 *
 *   pnpm tsx tools/export_outbound_logistica.ts \
 *     --raw-dir output/recall --out output/outbound_logistica_nord.csv
 */

const SLUGS = ['autotrasporti', 'trasporti_intl', 'spedizioni', 'logistica', 'corrieri', 'magazzini'] as const;

export const OUT_COLUMNS = [
  'ragione_sociale',
  'telefono_1',
  'telefono_2',
  'indirizzo',
  'cap',
  'comune',
  'provincia',
  'sito_web',
  'categoria_pg',
  'url_scheda_pg',
  'email',
  'descrizione',
  'scraped_at',
] as const;

/**
 * Esclusioni fuori-target (brief: "poche e sicure"). Due livelli:
 *   HARD — mai freight: taxi, NCC, noleggio con conducente, autoscuole.
 *   SOFT — traslochi / trasporto persone: escluso SOLO se il nome non porta
 *          anche un segnale freight/logistica esplicito. Così un'azienda che
 *          fa traslochi MA anche trasporto merci / deposito / spedizioni resta
 *          in lista (il filtro fine lo fa la pipeline a valle).
 */
export const HARD_OFF_TARGET_RE =
  /(?:^|[\s.,'"()-])(taxi|n\.?\s?c\.?\s?c\.?(?:[\s.,)]|$)|noleggio\s+con\s+conducente|autoscuol\w*)/i;
export const SOFT_OFF_TARGET_RE = /(traslochi|trasloco|trasporto\s+person[ei])/i;
export const FREIGHT_SIGNAL_RE =
  /(autotrasport|trasport[oi]\s+merci|conto\s+terzi|trasporti\s+(?:nazional|internazional)|spedizion|logistic|corrier[ei]|magazzin|deposit[oi]|movimento\s+terra|groupage|intermodal)/i;

export function isOffTarget(name: string): boolean {
  if (HARD_OFF_TARGET_RE.test(name)) return true;
  if (SOFT_OFF_TARGET_RE.test(name) && !FREIGHT_SIGNAL_RE.test(name)) return true;
  return false;
}

export interface OutboundRow {
  ragione_sociale: string;
  telefono_1: string;
  telefono_2: string;
  indirizzo: string;
  cap: string;
  comune: string;
  provincia: string;
  sito_web: string;
  categoria_pg: string;
  url_scheda_pg: string;
  email: string;
  descrizione: string;
  scraped_at: string;
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

export function leadToRow(lead: Lead, scrapedAt: string): OutboundRow {
  return {
    ragione_sociale: s(lead.company_name),
    telefono_1: s(lead.phone_raw) || s(lead.phone),
    telefono_2: '',
    indirizzo: s(lead.address),
    cap: s(lead.zip_code),
    comune: s(lead.business_city) || s(lead.city),
    provincia: s(lead.province),
    sito_web: s(lead.website),
    categoria_pg: s(lead.category),
    url_scheda_pg: s(lead.pg_url) || s(lead.source_url),
    email: s(lead.email),
    descrizione: s(lead.discovery_notes),
    scraped_at: scrapedAt,
  };
}

/** Chiave dedup del brief: telefono_1 (solo cifre) + comune (lowercase). */
export function dedupKey(row: OutboundRow): string | undefined {
  const digits = row.telefono_1.replace(/\D/g, '');
  if (!digits) return undefined;
  return `${digits}|${row.comune.toLowerCase()}`;
}

export function mergeRow(kept: OutboundRow, dup: OutboundRow): void {
  const cats = new Set(kept.categoria_pg.split(' | ').filter(Boolean));
  if (dup.categoria_pg && !cats.has(dup.categoria_pg)) {
    cats.add(dup.categoria_pg);
    kept.categoria_pg = [...cats].join(' | ');
  }
  for (const k of ['telefono_2', 'indirizzo', 'cap', 'sito_web', 'email', 'descrizione'] as const) {
    if (!kept[k] && dup[k]) kept[k] = dup[k];
  }
  // Un secondo numero DIVERSO emerso da un'altra categoria → telefono_2.
  if (dup.telefono_1 && dup.telefono_1.replace(/\D/g, '') !== kept.telefono_1.replace(/\D/g, '') && !kept.telefono_2) {
    kept.telefono_2 = dup.telefono_1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const rawDir = optString(args, 'raw-dir') ?? 'output/recall';
  const out = optString(args, 'out') ?? 'output/outbound_logistica_nord.csv';
  const reportPath = out.replace(/\.csv$/i, '') + '_report.json';

  const files = fs.existsSync(rawDir)
    ? fs
        .readdirSync(rawDir)
        .filter((f) => f.endsWith('_raw.jsonl') && SLUGS.some((slug) => f.startsWith(`${slug}_`)))
        .sort()
    : [];
  if (files.length === 0) throw new Error(`nessun raw jsonl dei settori logistica in ${rawDir} — lancia prima la campagna`);

  const byKey = new Map<string, OutboundRow>();
  const rows: OutboundRow[] = []; // ordine di arrivo, stabile
  const report = {
    files: files.length,
    perCell: {} as Record<string, number>,
    perProvincia: {} as Record<string, number>,
    letti: 0,
    esclusi_no_telefono: 0,
    esclusi_fuori_target: 0,
    dedup_merged: 0,
    output: 0,
  };

  for (const file of files) {
    const full = path.join(rawDir, file);
    const scrapedAt = fs.statSync(full).mtime.toISOString();
    const leads = await readJsonlAsLeads(full);
    report.perCell[file.replace('_raw.jsonl', '')] = leads.length;
    for (const lead of leads) {
      report.letti += 1;
      const row = leadToRow(lead, scrapedAt);
      if (!row.telefono_1) {
        report.esclusi_no_telefono += 1;
        continue;
      }
      if (isOffTarget(row.ragione_sociale)) {
        report.esclusi_fuori_target += 1;
        continue;
      }
      const key = dedupKey(row);
      const existing = key ? byKey.get(key) : undefined;
      if (existing) {
        mergeRow(existing, row);
        report.dedup_merged += 1;
        continue;
      }
      if (key) byKey.set(key, row);
      rows.push(row);
      report.perProvincia[row.provincia || '?'] = (report.perProvincia[row.provincia || '?'] ?? 0) + 1;
    }
  }
  report.output = rows.length;

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, stringify(rows, { header: true, columns: OUT_COLUMNS as unknown as string[], delimiter: ';' }));
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`export_outbound_logistica: ${report.letti} letti → ${report.output} righe (${out})`);
  console.log(
    `  esclusi: no-telefono ${report.esclusi_no_telefono} · fuori-target ${report.esclusi_fuori_target} · merged (tel+comune) ${report.dedup_merged}`,
  );
  console.log(`  per provincia: ${JSON.stringify(report.perProvincia)}`);
  console.log(`  report: ${reportPath}`);
}

runIfMain('export_outbound_logistica.ts', main);
