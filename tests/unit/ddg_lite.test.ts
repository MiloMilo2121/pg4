import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DdgLiteProvider } from '../../src/providers/serp/ddg_lite';

const html = fs.readFileSync(path.join(__dirname, '../fixtures/ddg_lite_sample.html'), 'utf8');

describe('DdgLiteProvider.parse', () => {
  it('extracts results from saved DDG-lite fixture', () => {
    const p = new DdgLiteProvider();
    const out = p.parse(html, 25);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out[0].title).toContain('Beauty Center Verona');
  });

  it('unwraps duckduckgo redirect URLs', () => {
    const p = new DdgLiteProvider();
    const out = p.parse(html, 25);
    expect(out[0].url).toBe('https://www.beautyverona.it/');
    expect(out.every((r) => r.url.startsWith('http'))).toBe(true);
  });

  it('captures snippets from sibling rows', () => {
    const p = new DdgLiteProvider();
    const out = p.parse(html, 25);
    expect(out[0].snippet).toContain('centro estetico');
  });

  it('honors limit', () => {
    const p = new DdgLiteProvider();
    expect(p.parse(html, 1)).toHaveLength(1);
  });

  it('returns [] for blocked-page HTML', () => {
    const blocked = '<html><body>If bots use DuckDuckGo too...</body></html>';
    expect(new DdgLiteProvider().parse(blocked, 25)).toEqual([]);
  });

  it('returns [] for empty html', () => {
    expect(new DdgLiteProvider().parse('', 25)).toEqual([]);
  });
});
