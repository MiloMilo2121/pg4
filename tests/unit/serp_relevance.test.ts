import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { BingHtmlProvider } from '../../src/providers/serp/bing_html';
import { DdgLiteProvider } from '../../src/providers/serp/ddg_lite';
import { looksUnrelated, queryTokens } from '../../src/providers/serp/relevance';
import { ProviderBlockError, type SerpResult } from '../../src/types/providers';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8');
const result = (title: string, snippet = '', url = 'https://example.com/'): SerpResult => ({
  title, snippet, url, rank: 1, source_provider: 'test',
});

describe('queryTokens', () => {
  it('drops operators, quotes, stopwords and short words; keeps match prefixes', () => {
    expect(queryTokens('"Idraulica Esempio srl" di Padova site:example.com -annunci')).toEqual(['idrauli', 'esemp', 'pado']);
  });

  it('folds accents', () => {
    expect(queryTokens('Caffè Città')).toEqual(['caff', 'citt']);
  });
});

describe('looksUnrelated', () => {
  it('is false for an empty page (a clean miss, not a block)', () => {
    expect(looksUnrelated('idraulico Padova', [])).toBe(false);
  });

  it('flags a page where no result shares the query tokens', () => {
    expect(looksUnrelated('idraulico Padova', [result('Accedere alla posta - Guida'), result('Creare un account')])).toBe(true);
  });

  it('matches plural and gender endings through the token prefix', () => {
    expect(looksUnrelated('idraulico Padova', [result('Migliori idraulici in zona')])).toBe(false);
  });

  it('needs half of the tokens: a generic word alone is not enough', () => {
    const page = [result('Home - Agenzia delle Entrate'), result('Area riservata - Agenzia delle Entrate')];
    expect(looksUnrelated('Agenzia Immobiliare Esempio Case Padova', page)).toBe(true);
  });

  it('counts the URL as part of the result', () => {
    expect(looksUnrelated('Idraulica Esempio', [result('Home', '', 'https://www.idraulica-esempio.example/')])).toBe(false);
  });
});

describe('BingHtmlProvider tracker links', () => {
  it('decodes /ck/a links to the target URL', () => {
    const out = new BingHtmlProvider().parse(fixture('bing_tracker_links.html'), 25);
    expect(out.map((r) => r.url)).toEqual([
      'https://www.idraulica-esempio.example/',
      'https://www.paginegialle.it/esempio/idraulica-esempio',
      expect.stringContaining('https://www.bing.com/ck/a'),
    ]);
  });

  it('leaves non-tracker and undecodable links unchanged', () => {
    expect(BingHtmlProvider.unwrapRedirect('https://www.beautyverona.it/')).toBe('https://www.beautyverona.it/');
    expect(BingHtmlProvider.unwrapRedirect('https://www.bing.com/ck/a?u=zz')).toBe('https://www.bing.com/ck/a?u=zz');
    expect(BingHtmlProvider.unwrapRedirect('https://evil.example/ck/a?u=a1aHR0cHM6Ly94LmV4YW1wbGUv')).toBe('https://evil.example/ck/a?u=a1aHR0cHM6Ly94LmV4YW1wbGUv');
  });
});

describe('DdgLiteProvider own links', () => {
  it('drops sponsored results and help links, keeps organic ones', () => {
    const out = new DdgLiteProvider().parse(fixture('ddg_lite_with_ads.html'), 25);
    expect(out.map((r) => r.url)).toEqual(['https://www.idraulica-esempio.example/']);
  });
});

describe('search() treats an unrelated page as a block', () => {
  let agent: MockAgent;
  let previous: Dispatcher;

  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(previous);
  });

  it('Bing: unrelated results throw ProviderBlockError so the router falls through', async () => {
    agent.get('https://www.bing.com').intercept({ path: /^\/search/, method: 'GET' }).reply(200, fixture('bing_unrelated.html'));
    await expect(new BingHtmlProvider().search('idraulico Padova')).rejects.toBeInstanceOf(ProviderBlockError);
  });

  it('Bing: related results are returned with decoded URLs', async () => {
    agent.get('https://www.bing.com').intercept({ path: /^\/search/, method: 'GET' }).reply(200, fixture('bing_tracker_links.html'));
    const out = await new BingHtmlProvider().search('Idraulica Esempio Padova');
    expect(out[0].url).toBe('https://www.idraulica-esempio.example/');
  });

  it('DDG: unrelated results throw ProviderBlockError', async () => {
    agent.get('https://lite.duckduckgo.com').intercept({ path: /^\/lite\//, method: 'GET' }).reply(200, fixture('ddg_lite_with_ads.html'));
    await expect(new DdgLiteProvider().search('ristorante Verona')).rejects.toBeInstanceOf(ProviderBlockError);
  });
});
