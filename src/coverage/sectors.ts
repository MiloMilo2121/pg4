/**
 * Catalogo settori scrapabili — fonte di verita' UNICA, da data/reference/sectors.json.
 *
 * Consumato da: driver di scraping (via node) e, lato codice, da chi deve sapere
 * quali settori sono "attivi" (analisi, dashboard, backlog). Aggiungere un
 * settore = un'unica modifica al JSON; qui non serve toccare nulla.
 */

import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../util/repo_root';

export interface Sector {
  /** id breve, es. "immobiliare" — usato nei nomi file <slug>_<PROV>_raw.csv. */
  slug: string;
  label: string;
  /** query principale su PagineGialle/Maps. */
  keyword: string;
  /** divisioni ATECO 2 cifre coperte dal settore (una o piu'). */
  atecoDivisions: string[];
  /** sinonimi per l'espansione --coverage full su Maps. */
  queryVariants: string[];
}

const DEFAULT_PATH = path.join(REPO_ROOT, 'data', 'reference', 'sectors.json');

let cache: Sector[] | undefined;

/** Carica (e cachea) il catalogo settori. */
export function loadSectors(file: string = DEFAULT_PATH): Sector[] {
  if (cache && file === DEFAULT_PATH) return cache;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { sectors?: Sector[] };
  const sectors = parsed.sectors ?? [];
  if (file === DEFAULT_PATH) cache = sectors;
  return sectors;
}

/** Lookup per slug. */
export function sectorBySlug(slug: string, file: string = DEFAULT_PATH): Sector | undefined {
  return loadSectors(file).find((s) => s.slug === slug);
}
