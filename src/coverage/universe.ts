/**
 * UniverseSource — il DENOMINATORE della coverage gap map.
 *
 * Astrazione deliberata: oggi l'unica impl e' `IstatAsiaUniverse` (CSV gratuito
 * ISTAT ASIA, imprese attive per divisione ATECO x provincia). L'interfaccia e'
 * l'hook per agganciare in futuro una fonte a pagamento azienda-per-azienda
 * (Registro Imprese / openapi) senza toccare il motore di copertura.
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { normProvince } from './geo_regions';
import { atecoDivisionOf } from './ateco';

export type UniverseProvenance = 'istat-asia' | 'sample' | string;

export interface UniverseCount {
  /** Numero imprese attive (universo totale, incl. ditte individuali). */
  activeFirms: number;
  year?: number;
  provenance: UniverseProvenance;
}

export interface UniverseSource {
  /** Conteggio universo per (divisione ATECO 2 cifre, sigla provincia), o null se ignoto. */
  count(division: string, province: string): UniverseCount | null;
  /** True se la fonte ha almeno una riga caricata. */
  hasData(): boolean;
  /** Etichetta della fonte (per provenance nel report). */
  readonly label: string;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PATH = path.join(REPO_ROOT, 'data', 'reference', 'istat_asia_universe.csv');

interface Row {
  ateco_division?: string;
  province?: string;
  active_firms?: string;
  year?: string;
  provenance?: string;
}

function key(division: string, province: string): string {
  return `${division}|${province}`;
}

/** Universo da CSV ISTAT ASIA. Preferisce righe `istat-asia` su `sample` per la stessa cella. */
export class IstatAsiaUniverse implements UniverseSource {
  readonly label = 'istat-asia';
  private readonly map = new Map<string, UniverseCount>();

  constructor(file: string = DEFAULT_PATH) {
    if (!fs.existsSync(file)) return; // nessun dato: count() ritorna null, il motore segnala "ignoto"
    const rows = parse(fs.readFileSync(file, 'utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Row[];
    for (const r of rows) {
      const division = atecoDivisionOf(r.ateco_division);
      const province = normProvince(r.province);
      const firms = Number(r.active_firms);
      if (!division || !province || !Number.isFinite(firms)) continue;
      const provenance = (r.provenance || 'unknown').trim();
      const entry: UniverseCount = {
        activeFirms: firms,
        year: r.year ? Number(r.year) : undefined,
        provenance,
      };
      const k = key(division, province);
      const existing = this.map.get(k);
      // Dato reale vince sempre sul sample; a parita' tiene il primo.
      if (!existing || (existing.provenance === 'sample' && provenance !== 'sample')) {
        this.map.set(k, entry);
      }
    }
  }

  count(division: string, province: string): UniverseCount | null {
    return this.map.get(key(division, normProvince(province))) ?? null;
  }

  hasData(): boolean {
    return this.map.size > 0;
  }
}
