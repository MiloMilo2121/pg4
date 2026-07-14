/**
 * Tassonomia ATECO 2007 (divisioni a 2 cifre) — caricata da
 * data/reference/ateco_divisions.json.
 *
 * Il file vive sotto data/ (fuori da rootDir=src), quindi lo leggiamo a runtime
 * via fs invece di importarlo, coerente con come api_server legge output/.
 */

import fs from 'fs';
import path from 'path';

export interface AtecoDivision {
  /** Codice divisione a 2 cifre, es. "68". */
  division: string;
  /** Sezione ATECO (lettera A..U). */
  section: string;
  /** Etichetta italiana. */
  label: string;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PATH = path.join(REPO_ROOT, 'data', 'reference', 'ateco_divisions.json');

let cache: AtecoDivision[] | undefined;

/** Carica (e cachea) la lista delle divisioni ATECO. */
export function loadAtecoDivisions(file: string = DEFAULT_PATH): AtecoDivision[] {
  if (cache && file === DEFAULT_PATH) return cache;
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as { divisions?: AtecoDivision[] };
  const divisions = parsed.divisions ?? [];
  if (file === DEFAULT_PATH) cache = divisions;
  return divisions;
}

/** Mappa division → AtecoDivision per lookup O(1). */
export function atecoIndex(file: string = DEFAULT_PATH): ReadonlyMap<string, AtecoDivision> {
  return new Map(loadAtecoDivisions(file).map((d) => [d.division, d]));
}

/**
 * Normalizza un codice ATECO grezzo (qualsiasi forma: "68.31", "682010",
 * "68.20.01", "L68") alla divisione a 2 cifre ("68"). Ritorna undefined se non
 * estraibile.
 */
export function atecoDivisionOf(rawAteco: string | undefined | null): string | undefined {
  if (!rawAteco) return undefined;
  // Prima sequenza di 2+ cifre nel codice.
  const m = String(rawAteco).match(/\d{2,}/);
  if (!m) return undefined;
  return m[0].slice(0, 2);
}

/** Etichetta leggibile di una divisione, o la divisione stessa se sconosciuta. */
export function atecoLabel(division: string, file: string = DEFAULT_PATH): string {
  return atecoIndex(file).get(division)?.label ?? division;
}
