import type { SerpResult } from '../../types/providers';
import { stripDiacritics } from '../../util/text';

/**
 * Free HTML SERPs sometimes answer a scraper with a page of results that has
 * nothing to do with the query (Bing has served Gmail help pages for
 * "idraulico Padova"). Those pages parse fine, so without this check the
 * router counts them as a success and never tries the next provider.
 *
 * A result is relevant when it contains at least half of the query's
 * significant tokens. Tokens are compared by a short prefix so that Italian
 * plural and gender endings still match ("idraulico" ↔ "idraulici").
 */

const STOPWORDS = new Set([
  'del', 'della', 'delle', 'dei', 'degli', 'dal', 'dalla', 'con', 'per', 'tra', 'fra',
  'and', 'the', 'srl', 'srls', 'snc', 'sas', 'spa',
]);

function fold(text: string): string {
  return stripDiacritics(text).toLowerCase();
}

/** Significant query tokens as match prefixes, without search operators. */
export function queryTokens(query: string): string[] {
  const words = fold(query)
    .split(/\s+/)
    .filter((w) => w && !w.startsWith('-') && !w.includes(':'))
    .flatMap((w) => w.split(/[^a-z0-9]+/))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const prefixes = words.map((w) => w.slice(0, Math.max(4, w.length - 2)));
  return [...new Set(prefixes)];
}

function isRelevantResult(tokens: string[], result: SerpResult): boolean {
  if (tokens.length === 0) return true;
  const haystack = fold(`${result.title} ${result.snippet} ${result.url}`);
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  return hits >= Math.ceil(tokens.length / 2);
}

/** True when a non-empty result page contains no result relevant to the query. */
export function looksUnrelated(query: string, results: SerpResult[]): boolean {
  if (results.length === 0) return false;
  const tokens = queryTokens(query);
  return !results.some((r) => isRelevantResult(tokens, r));
}
