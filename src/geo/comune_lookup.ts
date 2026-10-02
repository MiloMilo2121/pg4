/**
 * Lookup comune → sigla provincia, da data/reference/comuni_nord.json.
 *
 * Serve a recuperare i lead SENZA provincia risolta (in pratica: tutti quelli
 * scrapati da Google Maps, il cui parser non estrae la sigla dall'indirizzo).
 * Il coverage engine li bucketizzerebbe come "fuori scope" pur avendo una
 * `city` valida ("Padova") — qui li riagganciamo alla provincia giusta.
 *
 * Onestà sui casi ambigui: se lo stesso nome comune esiste in più province del
 * Nord (omonimie reali, es. "Samone" TO/TN, "Livo" CO/TN), il lookup ritorna
 * undefined invece di tirare a indovinare.
 */

import fs from 'fs';
import path from 'path';
import { stripDiacritics } from '../util/text';
import { REPO_ROOT } from '../util/repo_root';

const DEFAULT_PATH = path.join(REPO_ROOT, 'data', 'reference', 'comuni_nord.json');

function norm(s: string): string {
  return stripDiacritics(s.toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** valore: sigla provincia, oppure null se il nome è ambiguo (più province). */
let cache: Map<string, string | null> | undefined;

function buildIndex(file: string): Map<string, string | null> {
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const idx = new Map<string, string | null>();
  const add = (name: string, prov: string): void => {
    const k = norm(name);
    if (!k) return;
    const existing = idx.get(k);
    if (existing !== undefined && existing !== prov) {
      idx.set(k, null); // omonimia tra province → ambiguo
      return;
    }
    idx.set(k, prov);
  };
  for (const [prov, comuni] of Object.entries(j)) {
    if (prov === '_meta' || !Array.isArray(comuni)) continue;
    for (const name of comuni as string[]) {
      add(name, prov);
      // forme bilingui altoatesine "Bolzano/Bozen": indicizza entrambe le metà
      if (name.includes('/')) {
        for (const part of name.split('/')) add(part, prov);
      }
    }
  }
  return idx;
}

/**
 * Sigla provincia per un nome comune del Nord, o undefined se sconosciuto
 * o ambiguo. Case/accent-insensitive.
 */
export function provinceForComune(city: string | undefined | null, file: string = DEFAULT_PATH): string | undefined {
  if (!city) return undefined;
  if (!cache || file !== DEFAULT_PATH) {
    const idx = buildIndex(file);
    if (file === DEFAULT_PATH) cache = idx;
    else return lookupIn(idx, city);
  }
  return lookupIn(cache!, city);
}

function lookupIn(idx: Map<string, string | null>, city: string): string | undefined {
  const v = idx.get(norm(city));
  return v === null || v === undefined ? undefined : v;
}
