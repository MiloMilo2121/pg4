import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BingHtmlProvider } from '../../src/providers/serp/bing_html';

const html = fs.readFileSync(path.join(__dirname, '../fixtures/bing_sample.html'), 'utf8');

describe('BingHtmlProvider.parse', () => {
  it('extracts results from saved Bing fixture', () => {
    const p = new BingHtmlProvider();
    const out = p.parse(html, 25);
    expect(out.length).toBe(3);
    expect(out[0].title).toContain('Beauty Center Verona');
  });

  it('keeps direct URLs', () => {
    const p = new BingHtmlProvider();
    const out = p.parse(html, 25);
    expect(out[0].url).toBe('https://www.beautyverona.it/');
  });

  it('captures snippets from .b_caption p', () => {
    const p = new BingHtmlProvider();
    const out = p.parse(html, 25);
    expect(out[0].snippet).toContain('professionale');
  });

  it('honors limit', () => {
    const p = new BingHtmlProvider();
    expect(p.parse(html, 1)).toHaveLength(1);
  });

  it('returns [] for captcha block page', () => {
    const blocked = '<html><body>Please verify you are a human <div class="captcha-container"></div></body></html>';
    expect(new BingHtmlProvider().parse(blocked, 25)).toEqual([]);
  });
});
