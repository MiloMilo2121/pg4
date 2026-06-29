import type { SerpResult } from '../../types/providers';
import { isDirectoryOrSocial, isExtractableRegistry } from './content_filter';

/**
 * Combine SERP results from multiple providers into a ranked list of unique
 * official-looking domains. Deterministic, no LLM.
 *
 * Ranking signals (lower-is-worse, higher-is-better):
 *  + apex / www host (vs sub-page)
 *  + ccTLD `.it` for Italian leads
 *  + URL contains `/contatti`, `/chi-siamo`, `/about` (proves it's a real site)
 *  + multi-provider corroboration (>1 provider returned the same host)
 *  - directory/social hosts dropped
 *  - extractable registries kept but pushed to the end (low rank, may pivot)
 */
export interface RankedCandidate {
  url: string;          // canonical https://host (no path) for ranking comparisons
  host: string;
  best_url: string;     // the best URL we observed for this host (with path if useful)
  best_title: string;
  best_snippet: string;
  rank_score: number;   // 0..1
  source_providers: string[];
  is_registry: boolean;
}

export class SerpDeduplicator {
  /**
   * Merge results from any number of providers. Items keep their original
   * provenance via `source_providers`.
   */
  dedupe(batches: SerpResult[][], opts: { limit?: number } = {}): RankedCandidate[] {
    const byHost = new Map<string, RankedCandidate>();

    let providerIndex = 0;
    for (const batch of batches) {
      for (const r of batch) {
        const host = this.normalizeHost(r.url);
        if (!host) continue;
        // Order matters: extractable registries are technically also in DIRECTORIES,
        // but we keep them around (low-ranked) because the pipeline can pivot from
        // a registry page to the official site.
        const isReg = isExtractableRegistry(`https://${host}`);
        if (!isReg && isDirectoryOrSocial(`https://${host}`)) continue;
        const existing = byHost.get(host);
        if (!existing) {
          byHost.set(host, {
            url: `https://${host}`,
            host,
            best_url: r.url,
            best_title: r.title,
            best_snippet: r.snippet,
            rank_score: this.score(r, host, providerIndex, isReg, 1),
            source_providers: [r.source_provider],
            is_registry: isReg,
          });
        } else {
          if (!existing.source_providers.includes(r.source_provider)) {
            existing.source_providers.push(r.source_provider);
          }
          // Prefer apex/www URLs as canonical; keep first-seen for fallback
          const existingPath = this.pathLength(existing.best_url);
          const candPath = this.pathLength(r.url);
          if (candPath < existingPath) {
            existing.best_url = r.url;
            existing.best_title = r.title;
            existing.best_snippet = r.snippet;
          }
          // Bump score for multi-provider corroboration
          existing.rank_score = this.score(
            { title: existing.best_title, url: existing.best_url, snippet: existing.best_snippet, rank: 1, source_provider: '' },
            existing.host,
            providerIndex,
            existing.is_registry,
            existing.source_providers.length
          );
        }
      }
      providerIndex += 1;
    }

    const ranked = Array.from(byHost.values()).sort((a, b) => {
      if (a.is_registry !== b.is_registry) return a.is_registry ? 1 : -1; // registries last
      return b.rank_score - a.rank_score;
    });
    return ranked.slice(0, opts.limit ?? 20);
  }

  /** Lowercase host without `www.`. */
  private normalizeHost(rawUrl: string): string | undefined {
    try {
      const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
      return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return undefined;
    }
  }

  private pathLength(url: string): number {
    try {
      const u = new URL(url);
      return (u.pathname === '/' ? '' : u.pathname).length;
    } catch {
      return 999;
    }
  }

  /**
   * Compose a 0..1 rank score from deterministic signals.
   * Provider tier index gives a small bonus to earlier (cheaper) providers.
   */
  private score(r: SerpResult, host: string, providerIndex: number, isRegistry: boolean, providers: number): number {
    let s = 0.4;
    if (host.endsWith('.it')) s += 0.15;
    if (this.pathLength(r.url) === 0) s += 0.1;     // apex
    if (/contatti|chi[-\s]?siamo|about|privacy/i.test(r.url)) s += 0.05;
    if (providers >= 2) s += 0.15;                   // multi-provider corroboration
    if (providers >= 3) s += 0.05;
    if (providerIndex === 0) s += 0.05;              // free/deterministic provider first
    if (isRegistry) s -= 0.2;
    return Math.max(0, Math.min(1, s));
  }
}
