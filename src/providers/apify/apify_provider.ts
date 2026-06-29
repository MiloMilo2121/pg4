import { request } from 'undici';
import type { CostedMeta, ProviderRole } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { getEnv } from '../../config/env';

/**
 * Apify — external actor marketplace (Google Maps, contact/social scrapers).
 * Non-router family ('apify'): callers MUST invoke through `ProviderRouter.invoke`
 * so the same paid-gate / budget / run-ceiling / breaker / ledger apply (no
 * cost-safety bypass — addendum R1). Tier 2 / paid, OFF by default.
 *
 * Transport: `POST https://api.apify.com/v2/acts/{actorId}/run-sync-get-dataset-items`
 * with `?token=…&maxItems=N&timeout=…` → the dataset items JSON directly (good for
 * sub-5-minute single-place lookups). The HTTP call is injectable for offline tests.
 *
 * Legal: Google Maps is public business data (GREEN). The social-profile actors
 * (instagram/facebook/tiktok) are higher-ToS and gated by their own flags + a boot
 * warning — see provider_status.md. Spec: docs/provider_integration_specs.md#Apify.
 */

export type ApifyActor = 'maps' | 'contact' | 'instagram' | 'facebook' | 'tiktok' | 'registro';

/** Actor ids on the Apify marketplace (overridable via env for pinning/forking). */
const DEFAULT_ACTOR_IDS: Record<ApifyActor, string> = {
  maps: 'compass~crawler-google-places',
  contact: 'vdrmota~contact-info-scraper',
  instagram: 'apify~instagram-profile-scraper',
  facebook: 'apify~facebook-pages-scraper',
  tiktok: 'clockworks~tiktok-profile-scraper',
  // Italian business register (ufficiocamerale.it): firmographics + financials
  // by P.IVA — forma giuridica, ATECO, capitale, utile, dipendenti, PEC.
  registro: 'regdata~italy-registro-imprese-scraper',
};

/** Per-actor cost estimate in EUR (order-of-magnitude; the ledger records actuals). */
const ACTOR_COST_EUR: Record<ApifyActor, number> = {
  maps: 0.002,
  contact: 0.004,
  instagram: 0.0025,
  facebook: 0.0055,
  tiktok: 0.0015,
  registro: 0.018, // $0.01 record + $0.01 actor-start per single-company run
};

const ROLES: ReadonlyArray<ProviderRole> = ['REVIEWS_REPUTATION', 'SOCIAL_DETECT', 'B2B_CONTACT'];

/** What a Google-Maps place lookup yields for ONE company. */
export interface MapsPlace {
  name?: string;
  website?: string;
  phone?: string;
  rating?: string;
  reviews_count?: string;
  instagram?: string;
  facebook?: string;
  category?: string;
  address?: string;
}

/** Italian business-register firmographics for ONE company (by P.IVA). */
export interface RegistroRecord {
  name?: string; // denominazione (for the entity guard)
  legal_form?: string; // formaGiuridica
  ateco?: string; // "291 — Fabbricazione di autoveicoli"
  share_capital?: string; // capitaleSociale
  net_profit?: string; // utile (NOT fatturato — net profit)
  net_profit_year?: string; // utileAnno
  employees?: string; // dipendenti
  pec?: string;
  rea?: string;
  address?: string;
}

export type ApifyHttpPost = (url: string, body: unknown, timeoutMs: number) => Promise<{ status: number; json: unknown }>;

const defaultPost: ApifyHttpPost = async (url, body, timeoutMs) => {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  const status = res.statusCode;
  if (status === 401 || status === 403) {
    await res.body.dump();
    throw new ProviderBlockError('apify', `apify auth failure (${status})`);
  }
  if (status === 429) {
    await res.body.dump();
    throw new ProviderBlockError('apify', 'apify rate limit (429)');
  }
  let json: unknown = [];
  try {
    json = await res.body.json();
  } catch {
    json = [];
  }
  return { status, json };
};

export class ApifyProvider {
  readonly id = 'apify';
  readonly family = 'apify' as const;
  readonly roles = ROLES;

  constructor(private post: ApifyHttpPost = defaultPost) {}

  /** Master availability — the key + the global Apify flag. */
  available(): boolean {
    const e = getEnv();
    return e.APIFY_ENABLED === true && typeof e.APIFY_API_KEY === 'string' && e.APIFY_API_KEY.length > 0;
  }

  /** Per-actor availability also checks the actor's own flag (RED actors default OFF). */
  actorAvailable(actor: ApifyActor): boolean {
    if (!this.available()) return false;
    const e = getEnv();
    switch (actor) {
      case 'maps':
        return e.APIFY_MAPS_ENABLED === true;
      case 'contact':
        return e.APIFY_CONTACT_ENABLED === true;
      case 'instagram':
        return e.APIFY_INSTAGRAM_ENABLED === true;
      case 'facebook':
        return e.APIFY_FACEBOOK_ENABLED === true;
      case 'tiktok':
        return e.APIFY_TIKTOK_ENABLED === true;
      case 'registro':
        return e.APIFY_REGISTRO_ENABLED === true;
    }
  }

  /** Cost-gated descriptor for one actor — pass to router.invoke for spend safety. */
  meta(actor: ApifyActor): CostedMeta {
    return {
      id: `apify_${actor}`,
      family: this.family,
      tier: 2,
      costPerCallEur: ACTOR_COST_EUR[actor],
      available: () => this.actorAvailable(actor),
      roles: this.roles,
    };
  }

  private actorId(actor: ApifyActor): string {
    return DEFAULT_ACTOR_IDS[actor];
  }

  /**
   * Run an actor synchronously, returning its dataset items (bounded). Never
   * throws on empty. Pass `maxItems: null` to OMIT the `maxItems` query param —
   * some PAY_PER_EVENT actors (regdata registro) ABORT the run when it is set;
   * those cap their output via an input field (`maxResults`) instead.
   */
  async runActorSync(actor: ApifyActor, input: unknown, opts: { maxItems?: number | null; timeoutMs?: number } = {}): Promise<unknown[]> {
    const e = getEnv();
    const token = e.APIFY_API_KEY;
    if (!token) throw new ProviderBlockError(this.id, 'apify key missing');
    const timeoutMs = opts.timeoutMs ?? 240_000;
    const maxItemsQs = opts.maxItems === null ? '' : `&maxItems=${opts.maxItems ?? 1}`;
    const url =
      `https://api.apify.com/v2/acts/${this.actorId(actor)}/run-sync-get-dataset-items` +
      `?token=${encodeURIComponent(token)}${maxItemsQs}&timeout=${Math.round(timeoutMs / 1000)}`;
    const { json } = await this.post(url, input, timeoutMs);
    return Array.isArray(json) ? json : [];
  }

  /** Google-Maps lookup for ONE company (name + city) → the best place. */
  async mapsLookup(name: string, city: string | undefined, opts: { timeoutMs?: number } = {}): Promise<MapsPlace | undefined> {
    const query = [name, city].filter(Boolean).join(' ').trim();
    if (!query) return undefined;
    const items = await this.runActorSync(
      'maps',
      { searchStringsArray: [query], maxCrawledPlacesPerSearch: 1, language: 'it', skipClosedPlaces: true },
      { maxItems: 1, timeoutMs: opts.timeoutMs },
    );
    return items.length > 0 ? ApifyProvider.parseMapsItem(items[0]) : undefined;
  }

  /** PURE parser for a Google-Maps actor item (exposed for tests). Defensive on shape. */
  static parseMapsItem(raw: unknown): MapsPlace {
    const it = (raw ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
    const firstUrl = (v: unknown, host: RegExp): string | undefined => {
      const arr = Array.isArray(v) ? v : v ? [v] : [];
      for (const u of arr) if (typeof u === 'string' && host.test(u)) return u.split('?')[0];
      return undefined;
    };
    // A real website only — NEVER the Google-Maps listing URL (it.url). When a
    // business has no site, the actor leaves `website` empty and `url` is the
    // maps.google link; using it as official_website is a false positive.
    const realSite = (v: unknown): string | undefined => {
      const u = str(v);
      return u && !/google\.[a-z.]+\/maps|maps\.google\.|\/maps\/search/i.test(u) ? u : undefined;
    };
    return {
      name: str(it.title) ?? str(it.name),
      website: realSite(it.website),
      phone: str(it.phone) ?? str(it.phoneUnformatted),
      rating: str(it.totalScore) ?? str(it.rating),
      reviews_count: str(it.reviewsCount) ?? str(it.reviewsCountText),
      instagram: firstUrl(it.instagrams, /instagram\.com/i),
      facebook: firstUrl(it.facebooks, /facebook\.com/i),
      category: str(it.categoryName) ?? str(it.category),
      address: str(it.address) ?? str(it.street),
    };
  }

  /** Italian business-register lookup for ONE company by P.IVA → firmographics. */
  async registroLookup(vat: string, opts: { timeoutMs?: number } = {}): Promise<RegistroRecord | undefined> {
    const q = (vat || '').replace(/\D/g, '');
    if (q.length !== 11) return undefined;
    // NB: maxItems:null — the regdata actor ABORTS if the run-sync maxItems query
    // param is set; it caps output via the `maxResults` input field instead.
    const items = await this.runActorSync('registro', { query: q, maxResults: 1 }, { maxItems: null, timeoutMs: opts.timeoutMs ?? 180_000 });
    return items.length > 0 ? ApifyProvider.parseRegistroItem(items[0]) : undefined;
  }

  /** PURE parser for a regdata registro-imprese item (exposed for tests). */
  static parseRegistroItem(raw: unknown): RegistroRecord {
    const it = (raw ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
    const ateco = [str(it.atecoCode), str(it.atecoDescription)].filter(Boolean).join(' — ') || undefined;
    return {
      name: str(it.denominazione) ?? str(it.name),
      legal_form: str(it.formaGiuridica),
      ateco,
      share_capital: str(it.capitaleSociale),
      net_profit: str(it.utile),
      net_profit_year: str(it.utileAnno),
      employees: str(it.dipendenti),
      pec: str(it.pec),
      rea: str(it.rea),
      address: str(it.indirizzo) ?? str(it.address),
    };
  }
}
