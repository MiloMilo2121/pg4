/**
 * Crosswalk categoria di scraping <-> divisione ATECO.
 *
 * Forward  (classify): "agenzie immobiliari" -> "68". Bridge tra il `category`
 *          free-text dei lead e le righe dell'universo. Disambigua scegliendo il
 *          token MATCHATO PIU' LUNGO ("barbiere" batte "bar"), cosi' token corti
 *          non rubano categorie piu' specifiche.
 * Reverse  (keywordsFor): "68" -> ["agenzie immobiliari", "mediatore ...", ...].
 *          Alimenta il backlog (cosa cercare per coprire una divisione).
 *
 * Dati: data/reference/category_ateco_map.json (letto a runtime).
 */

import fs from 'fs';
import path from 'path';

export interface CrosswalkEntry {
  division: string;
  tokens: string[];
  scrapeKeywords: string[];
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PATH = path.join(REPO_ROOT, 'data', 'reference', 'category_ateco_map.json');

/** lowercase + strip accenti + solo alfanumerici/spazi — stesso schema di category_match.ts. */
export function normalizeCategory(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Crosswalk {
  private readonly entries: CrosswalkEntry[];
  /** (token normalizzato, lunghezza, divisione) precomputati, ordinati per lunghezza desc. */
  private readonly tokenIndex: Array<{ token: string; len: number; division: string }>;

  constructor(file: string = DEFAULT_PATH) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: CrosswalkEntry[] };
    this.entries = parsed.entries ?? [];
    this.tokenIndex = this.entries
      .flatMap((e) => e.tokens.map((t) => ({ token: normalizeCategory(t), division: e.division })))
      .map((x) => ({ ...x, len: x.token.length }))
      .filter((x) => x.token.length > 0)
      .sort((a, b) => b.len - a.len);
  }

  /**
   * Classifica una categoria free-text nella divisione ATECO, o undefined se
   * nessun token combacia. Vince il token combaciante piu' lungo.
   */
  classify(category: string | undefined | null): string | undefined {
    if (!category) return undefined;
    const cat = normalizeCategory(category);
    if (!cat) return undefined;
    for (const { token, division } of this.tokenIndex) {
      if (cat.includes(token)) return division;
    }
    return undefined;
  }

  /** Keyword di scraping consigliate per coprire una divisione (ordinate per resa). */
  keywordsFor(division: string): string[] {
    return this.entries.find((e) => e.division === division)?.scrapeKeywords ?? [];
  }

  /** Tutte le divisioni che il crosswalk sa classificare/coprire. */
  knownDivisions(): string[] {
    return this.entries.map((e) => e.division);
  }
}
