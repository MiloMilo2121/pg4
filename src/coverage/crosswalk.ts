/**
 * Crosswalk between scraping category <-> ATECO division.
 *
 * Forward  (classify): "agenzie immobiliari" -> "68". Bridge between the leads'
 *          free-text `category` and the universe rows. Disambiguates by picking the
 *          LONGEST MATCHED token ("barbiere" beats "bar"), so short tokens
 *          do not steal more specific categories.
 * Reverse  (keywordsFor): "68" -> ["agenzie immobiliari", "mediatore ...", ...].
 *          Feeds the backlog (what to search for to cover a division).
 *
 * Data: data/reference/category_ateco_map.json (read at runtime).
 */

import fs from 'fs';
import path from 'path';
import { stripDiacritics } from '../util/text';
import { REPO_ROOT } from '../util/repo_root';

export interface CrosswalkEntry {
  division: string;
  tokens: string[];
  scrapeKeywords: string[];
}

const DEFAULT_PATH = path.join(REPO_ROOT, 'data', 'reference', 'category_ateco_map.json');

/** lowercase + strip accents + alphanumerics/spaces only — same scheme as category_match.ts. */
function normalizeCategory(s: string): string {
  return stripDiacritics(s.toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Crosswalk {
  private readonly entries: CrosswalkEntry[];
  /** Precomputed (normalized token, length, division), sorted by length desc. */
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
   * Classifies a free-text category into its ATECO division, or undefined if
   * no token matches. The longest matching token wins.
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

  /** Recommended scraping keywords to cover a division (sorted by yield). */
  keywordsFor(division: string): string[] {
    return this.entries.find((e) => e.division === division)?.scrapeKeywords ?? [];
  }

  /** All divisions the crosswalk can classify/cover. */
  knownDivisions(): string[] {
    return this.entries.map((e) => e.division);
  }
}
