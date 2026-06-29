import { describe, it, expect } from 'vitest';
import { SerpDeduplicator } from '../../src/discovery/website/serp_deduplicator';
import type { SerpResult } from '../../src/types/providers';

const r = (url: string, source: string, title = 'Title', snippet = ''): SerpResult => ({
  url,
  title,
  snippet,
  rank: 1,
  source_provider: source,
});

describe('SerpDeduplicator', () => {
  it('drops directory/social hosts', () => {
    const d = new SerpDeduplicator();
    const out = d.dedupe([
      [r('https://www.linkedin.com/company/foo', 'ddg_lite')],
      [r('https://www.facebook.com/foo', 'bing_html')],
      [r('https://example.it', 'ddg_lite')],
    ]);
    expect(out.map((c) => c.host)).toEqual(['example.it']);
  });

  it('merges duplicates from different providers and bumps multi-provider score', () => {
    const d = new SerpDeduplicator();
    const out = d.dedupe([
      [r('https://example.it', 'ddg_lite')],
      [r('https://www.example.it/contatti', 'bing_html')],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source_providers.sort()).toEqual(['bing_html', 'ddg_lite']);
    // multi-provider lift: score above the single-provider baseline
    expect(out[0].rank_score).toBeGreaterThan(0.55);
  });

  it('prefers shorter (apex) URLs as best_url', () => {
    const d = new SerpDeduplicator();
    const out = d.dedupe([
      [r('https://example.it/blog/long/path', 'ddg_lite')],
      [r('https://example.it', 'bing_html')],
    ]);
    expect(out[0].best_url).toBe('https://example.it');
  });

  it('pushes registries (fatturatoitalia, etc) to the end', () => {
    const d = new SerpDeduplicator();
    const out = d.dedupe([
      [r('https://fatturatoitalia.it/azienda/123', 'ddg_lite')],
      [r('https://example.it', 'bing_html')],
    ]);
    expect(out[0].host).toBe('example.it');
    expect(out[out.length - 1].is_registry).toBe(true);
  });

  it('boosts .it domains over generic TLDs', () => {
    const d = new SerpDeduplicator();
    const out = d.dedupe([[
      r('https://example.com', 'ddg_lite'),
      r('https://example.it', 'ddg_lite'),
    ]]);
    const it = out.find((c) => c.host === 'example.it')!;
    const com = out.find((c) => c.host === 'example.com')!;
    expect(it.rank_score).toBeGreaterThan(com.rank_score);
  });

  it('honors limit', () => {
    const d = new SerpDeduplicator();
    const batch = Array.from({ length: 30 }, (_, i) => r(`https://h${i}.example.it`, 'ddg_lite'));
    expect(d.dedupe([batch], { limit: 5 })).toHaveLength(5);
  });
});
