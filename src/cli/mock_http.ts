import fs from 'fs';
import path from 'path';
import { ProviderRouter } from '../providers/provider_router';
import { PgDetailHarvester } from '../discovery/sources/pagine_gialle_detail_harvester';
import type { CostLedger } from '../runtime/cost_ledger';
import type { HttpFetchResult, HttpProvider } from '../types/providers';

type MockHttpFixture = Record<string, string>;

export function buildMockHttpRouter(ledger: CostLedger, fixturePath: string): ProviderRouter {
  return new ProviderRouter([], [new MockHttpProvider(fixturePath)], [], ledger);
}

export function buildNoopPgDetailHarvester(): PgDetailHarvester {
  return new PgDetailHarvester({
    fetchHtml: async () => ({ status: 404 }),
  });
}

class MockHttpProvider implements HttpProvider {
  readonly id = 'mock_http';
  readonly family = 'http' as const;
  readonly tier = 0;
  readonly costPerCallEur = 0;
  private readonly pages: Map<string, string>;

  constructor(fixturePath: string) {
    this.pages = loadPages(fixturePath);
  }

  available(): boolean {
    return true;
  }

  async fetch(url: string): Promise<HttpFetchResult> {
    const start = Date.now();
    const html = this.pages.get(canonicalUrlKey(url));
    if (!html) {
      return {
        status: 404,
        html: undefined,
        finalUrl: url,
        duration_ms: Date.now() - start,
        cost_eur: 0,
        provider: this.id,
        error: 'mock fixture miss',
      };
    }
    return {
      status: 200,
      html,
      finalUrl: url,
      duration_ms: Date.now() - start,
      cost_eur: 0,
      provider: this.id,
    };
  }
}

function loadPages(fixturePath: string): Map<string, string> {
  const resolved = path.resolve(fixturePath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Mock HTTP fixture must be a JSON object: ${resolved}`);
  }

  const pages = new Map<string, string>();
  for (const [url, html] of Object.entries(parsed as MockHttpFixture)) {
    if (typeof html !== 'string' || html.trim() === '') {
      throw new Error(`Mock HTTP fixture value must be non-empty HTML for ${url}`);
    }
    pages.set(canonicalUrlKey(url), html);
  }
  return pages;
}

function canonicalUrlKey(url: string): string {
  const u = new URL(url);
  u.hostname = u.hostname.toLowerCase();
  u.protocol = u.protocol.toLowerCase();
  return u.toString().replace(/\/$/, '');
}
