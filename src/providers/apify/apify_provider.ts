import { request } from 'undici';
import type { CostedMeta, ProviderRole } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { getEnv } from '../../config/env';
import { withRetry, isRetriableNavError } from '../../runtime/retry';
import { isGoogleMapsUrl } from '../../discovery/sources/maps_url';

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

export type ApifyActor =
  | 'maps'
  | 'contact'
  | 'instagram'
  | 'facebook'
  | 'tiktok'
  | 'registro'
  // ENRICH-3 — real-estate portal bulk scrapers (per-province, joined offline),
  // balance-sheet register, and a pluggable email verifier.
  | 'portal_immobiliare'
  | 'portal_immobiliare_ads'
  | 'portal_wikicasa'
  | 'bilanci'
  | 'email_verify';

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
  // immobiliare.it agency directory. memo23 (22k+ runs) auto-paginates the
  // whole directory with agency detail pages; azzouzana was DROPPED after the
  // probe measured ~5 items/run + a 1-minute free-tier rate limit between runs.
  portal_immobiliare: 'memo23~immobiliare-scraper',
  // immobiliare.it agencies with listing counts / isPaid / FIAIP (no emails).
  portal_immobiliare_ads: 'saregaa~immobiliareit-scraper',
  // wikicasa.it agency directory (website + phones).
  portal_wikicasa: 'stealth_mode~wikicasa-agency-search-scraper',
  // registroimprese balance sheets: PEC + fatturato + dipendenti + capitale.
  bilanci: 'jungle_synthesizer~italy-registroimprese-bilanci-scraper',
  // No default: the operator validates a marketplace verifier at probe time
  // and pins it via APIFY_EMAIL_VERIFY_ACTOR_ID (actorAvailable requires it).
  email_verify: '',
};

/** Per-actor cost estimate in EUR (order-of-magnitude; the ledger records actuals). */
const ACTOR_COST_EUR: Record<ApifyActor, number> = {
  maps: 0.002,
  contact: 0.004,
  instagram: 0.0025,
  facebook: 0.0055,
  tiktok: 0.0015,
  registro: 0.018, // $0.01 record + $0.01 actor-start per single-company run
  portal_immobiliare: 0.0007, // per agency item ($0.70/1K, PAY_PER_EVENT)
  portal_immobiliare_ads: 0.0007, // per agency item
  portal_wikicasa: 0.002, // per agency item
  bilanci: 0.008, // per company record
  email_verify: 0.001, // per verified email
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
  /** ENRICH-3 — amministratore/titolare when the actor exposes it (only source for DM). */
  decision_maker_name?: string;
  decision_maker_role?: string;
}

/**
 * ENRICH-3 — registroimprese BALANCE-SHEET record (jungle_synthesizer actor).
 * Unlike regdata's RegistroRecord, this source exposes real FATTURATO
 * (revenue), which must never be conflated with utile/net_profit.
 */
export interface BilanciRecord {
  vat?: string;
  name?: string;
  pec?: string;
  revenue?: string;
  revenue_year?: string;
  employees?: string;
  share_capital?: string;
  legal_form?: string;
  ateco?: string;
  address?: string;
}

/** ENRICH-3 — one email's deliverability verdict from the pluggable verifier actor. */
export interface EmailVerifyResult {
  email?: string;
  status: 'deliverable' | 'catch_all' | 'invalid' | 'unknown';
}

/**
 * ENRICH-3 — single place encoding the bilanci actor's input shape (a
 * probe-validated guess: the actor has never run here). If the probe shows a
 * different schema, fix it HERE only.
 */
export function buildBilanciInput(vat: string): Record<string, unknown> {
  return { query: vat, searchQuery: vat, maxResults: 1 };
}

const APIFY_API = 'https://api.apify.com/v2';
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

/** A finished async run: items (bounded by `maxItems`) + what it really cost. */
export interface ApifyRunResult {
  items: unknown[];
  runId: string;
  datasetId: string;
  /** Items the actor pushed — the pay-per-result billing basis (≥ items.length). */
  billedItems: number;
  cost_eur: number;
}

/**
 * Failure of an async run. Carries `cost_eur` (see `errorCostEur`) so the
 * router's ledger records the real spend, and — when the run SUCCEEDED but its
 * dataset could not be downloaded — the ids needed to fetch it later for free.
 */
export class ApifyRunError extends Error {
  readonly runId?: string;
  readonly datasetId?: string;
  readonly succeeded: boolean;
  readonly cost_eur?: number;
  constructor(message: string, info: { runId?: string; datasetId?: string; succeeded?: boolean; cost_eur?: number } = {}) {
    super(message);
    this.name = 'ApifyRunError';
    this.runId = info.runId;
    this.datasetId = info.datasetId;
    this.succeeded = info.succeeded === true;
    this.cost_eur = info.cost_eur;
  }
}

class TransientApifyError extends Error {
  constructor(readonly status: number) {
    super(`apify transient HTTP ${status}`);
    this.name = 'TransientApifyError';
  }
}

export type ApifyHttpPost = (url: string, body: unknown, timeoutMs: number) => Promise<{ status: number; json: unknown }>;
export type ApifyHttpGet = (url: string, timeoutMs: number) => Promise<{ status: number; json: unknown }>;

/** Shared response handling: map auth/rate-limit to ProviderBlockError, parse JSON defensively. */
async function readApifyResponse(res: { statusCode: number; body: { dump(): Promise<void>; json(): Promise<unknown> } }): Promise<{ status: number; json: unknown }> {
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
}

const defaultPost: ApifyHttpPost = async (url, body, timeoutMs) => {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  return readApifyResponse(res);
};

const defaultGet: ApifyHttpGet = async (url, timeoutMs) => {
  const res = await request(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  return readApifyResponse(res);
};

export class ApifyProvider {
  readonly id = 'apify';
  readonly family = 'apify' as const;
  readonly roles = ROLES;

  /** Backoff base for transient GET retries (tests pass 0). */
  private readonly retryBaseMs: number;

  constructor(
    private post: ApifyHttpPost = defaultPost,
    private get: ApifyHttpGet = defaultGet,
    opts: { retryBaseMs?: number } = {},
  ) {
    this.retryBaseMs = opts.retryBaseMs ?? 2_000;
  }

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
      case 'portal_immobiliare':
        return e.APIFY_PORTAL_IMMOBILIARE_ENABLED === true;
      case 'portal_immobiliare_ads':
        return e.APIFY_PORTAL_IMMOBILIARE_ADS_ENABLED === true;
      case 'portal_wikicasa':
        return e.APIFY_PORTAL_WIKICASA_ENABLED === true;
      case 'bilanci':
        return e.APIFY_BILANCI_ENABLED === true;
      case 'email_verify':
        // No default actor id — enabling requires the operator to pin one.
        return e.APIFY_EMAIL_VERIFY_ENABLED === true && !!e.APIFY_EMAIL_VERIFY_ACTOR_ID;
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
    const e = getEnv();
    const override: Partial<Record<ApifyActor, string | undefined>> = {
      portal_immobiliare: e.APIFY_PORTAL_IMMOBILIARE_ACTOR_ID,
      portal_immobiliare_ads: e.APIFY_PORTAL_IMMOBILIARE_ADS_ACTOR_ID,
      portal_wikicasa: e.APIFY_PORTAL_WIKICASA_ACTOR_ID,
      bilanci: e.APIFY_BILANCI_ACTOR_ID,
      email_verify: e.APIFY_EMAIL_VERIFY_ACTOR_ID,
    };
    return override[actor] || DEFAULT_ACTOR_IDS[actor];
  }

  /**
   * Run an actor synchronously, returning its dataset items (bounded). Never
   * throws on empty. Pass `maxItems: null` to OMIT the `maxItems` query param —
   * some PAY_PER_EVENT actors (regdata registro) ABORT the run when it is set;
   * those cap their output via an input field (`maxResults`) instead.
   */
  async runActorSync(actor: ApifyActor, input: unknown, opts: { maxItems?: number | null; timeoutMs?: number } = {}): Promise<unknown[]> {
    const timeoutMs = opts.timeoutMs ?? 240_000;
    const maxItemsQs = opts.maxItems === null ? '' : `&maxItems=${opts.maxItems ?? 1}`;
    const url =
      `${APIFY_API}/acts/${this.actorId(actor)}/run-sync-get-dataset-items` +
      `?${this.tokenQs()}${maxItemsQs}&timeout=${Math.round(timeoutMs / 1000)}`;
    const { json } = await this.post(url, input, timeoutMs);
    return Array.isArray(json) ? json : [];
  }

  /**
   * ENRICH-3 — asynchronous actor run for BULK jobs that exceed the ~300s
   * run-sync window (per-province portal scrapes, chunked register lookups).
   * Start run → poll status → download dataset items.
   *
   * Money safety — every failure THROWS an `ApifyRunError` (never a silent
   * `[]`, which would read as "€0, nothing to save" and make a resume pay the
   * same run twice):
   *   - start rejected (4xx)          → cost_eur 0 (nothing ran)
   *   - terminal FAILED/ABORTED/...   → cost_eur from the items the run pushed
   *   - deadline                       → the run is ABORTED first (it would
   *                                      keep billing), then cost as above
   *   - items download failed          → `succeeded: true` + runId/datasetId so
   *                                      the caller can re-download for free
   * `cost_eur` stays undefined when the spend is unknowable; the router then
   * records the worst-case reservation. Status/items GETs retry transient
   * failures (5xx, socket errors) with backoff.
   */
  async runActorAsync(actor: ApifyActor, input: unknown, opts: { maxItems?: number; timeoutMs?: number; pollMs?: number } = {}): Promise<ApifyRunResult> {
    const tokenQs = this.tokenQs();
    const timeoutMs = opts.timeoutMs ?? 1_200_000; // bulk province scrapes routinely take >5 min
    const pollMs = opts.pollMs ?? 10_000;

    const start = await this.post(`${APIFY_API}/acts/${this.actorId(actor)}/runs?${tokenQs}`, input, 60_000);
    const startData = ((start.json ?? {}) as { data?: Record<string, unknown> }).data ?? {};
    const runId = typeof startData.id === 'string' ? startData.id : undefined;
    const datasetId = typeof startData.defaultDatasetId === 'string' ? startData.defaultDatasetId : undefined;
    if (start.status >= 400 || !runId || !datasetId) {
      // A 4xx start never created a run; a 5xx / malformed reply MIGHT have.
      const cost = start.status >= 400 && start.status < 500 ? 0 : undefined;
      throw new ApifyRunError(`apify run start failed for ${actor} (status ${start.status})`, { cost_eur: cost });
    }

    const deadline = Date.now() + timeoutMs;
    let runStatus = typeof startData.status === 'string' ? startData.status : 'READY';
    while (!TERMINAL_RUN_STATUSES.has(runStatus)) {
      if (Date.now() > deadline) {
        await this.post(`${APIFY_API}/actor-runs/${runId}/abort?${tokenQs}`, {}, 30_000).catch(() => undefined);
        throw new ApifyRunError(`apify run ${runId} (${actor}) still ${runStatus} after ${timeoutMs}ms — aborted`, {
          runId,
          datasetId,
          cost_eur: await this.pushedCostEur(actor, datasetId),
        });
      }
      if (pollMs > 0) await new Promise<void>((r) => setTimeout(r, pollMs));
      const st = await this.getWithRetry(`${APIFY_API}/actor-runs/${runId}?${tokenQs}`, 30_000);
      const d = ((st.json ?? {}) as { data?: Record<string, unknown> }).data ?? {};
      if (typeof d.status === 'string') runStatus = d.status;
    }
    if (runStatus !== 'SUCCEEDED') {
      throw new ApifyRunError(`apify run ${runId} (${actor}) ended ${runStatus}`, {
        runId,
        datasetId,
        cost_eur: await this.pushedCostEur(actor, datasetId),
      });
    }

    let items: unknown[];
    try {
      items = await this.fetchDatasetItems(datasetId, opts.maxItems);
    } catch (err) {
      throw new ApifyRunError(`apify run ${runId} (${actor}) SUCCEEDED but dataset ${datasetId} download failed: ${(err as Error).message}`, {
        runId,
        datasetId,
        succeeded: true,
        cost_eur: await this.pushedCostEur(actor, datasetId),
      });
    }
    // Billing basis is what the actor PUSHED, not what `limit` let us download.
    const billedItems = Math.max(items.length, (await this.datasetItemCount(datasetId)) ?? 0);
    return { items, runId, datasetId, billedItems, cost_eur: billedItems * ACTOR_COST_EUR[actor] };
  }

  /**
   * Download a finished run's dataset (a read — no actor run, no per-item
   * charge). Used by `runActorAsync` and by resumes that already paid for the
   * run. Throws on a non-2xx or non-array reply: "download failed" must never
   * look like "the actor found nothing".
   */
  async fetchDatasetItems(datasetId: string, limit?: number): Promise<unknown[]> {
    const limitQs = limit !== undefined ? `&limit=${limit}` : '';
    const res = await this.getWithRetry(`${APIFY_API}/datasets/${datasetId}/items?${this.tokenQs()}&clean=true${limitQs}`, 120_000);
    if (res.status < 200 || res.status >= 300 || !Array.isArray(res.json)) {
      throw new Error(`dataset ${datasetId} items: status ${res.status}${Array.isArray(res.json) ? '' : ', body is not an array'}`);
    }
    return res.json;
  }

  /** Items the run pushed to its dataset (dataset metadata), or undefined when unreadable. */
  private async datasetItemCount(datasetId: string): Promise<number | undefined> {
    try {
      const res = await this.getWithRetry(`${APIFY_API}/datasets/${datasetId}?${this.tokenQs()}`, 30_000);
      const n = ((res.json ?? {}) as { data?: { itemCount?: unknown } }).data?.itemCount;
      return res.status >= 200 && res.status < 300 && typeof n === 'number' && n >= 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }

  private async pushedCostEur(actor: ApifyActor, datasetId: string): Promise<number | undefined> {
    const n = await this.datasetItemCount(datasetId);
    return n === undefined ? undefined : n * ACTOR_COST_EUR[actor];
  }

  /** GET with backoff on transient failures (5xx, socket/timeout errors). Auth/rate-limit blocks are NOT retried. */
  private getWithRetry(url: string, timeoutMs: number): Promise<{ status: number; json: unknown }> {
    return withRetry(
      async () => {
        const res = await this.get(url, timeoutMs);
        if (res.status >= 500) throw new TransientApifyError(res.status);
        return res;
      },
      {
        retries: 3,
        baseBackoffMs: this.retryBaseMs,
        isRetriable: (err) => err instanceof TransientApifyError || (!(err instanceof ProviderBlockError) && isRetriableNavError(err)),
      },
    ).catch((err: unknown) => {
      // Retries exhausted on 5xx: surface the status as a response so callers decide.
      if (err instanceof TransientApifyError) return { status: err.status, json: undefined };
      throw err;
    });
  }

  private tokenQs(): string {
    const token = getEnv().APIFY_API_KEY;
    if (!token) throw new ProviderBlockError(this.id, 'apify key missing');
    return `token=${encodeURIComponent(token)}`;
  }

  /**
   * Google-Maps lookup for ONE company → the best place. When the scraper
   * already captured the place URL (`opts.placeUrl`, a /maps/place/… link),
   * the actor crawls THAT place directly — more precise and cheaper than a
   * text search that can land on a namesake. Text search (name + city) is
   * the fallback for leads without a place URL.
   */
  async mapsLookup(name: string, city: string | undefined, opts: { timeoutMs?: number; placeUrl?: string } = {}): Promise<MapsPlace | undefined> {
    let input: Record<string, unknown>;
    if (opts.placeUrl) {
      input = { startUrls: [{ url: opts.placeUrl }], maxCrawledPlacesPerSearch: 1, language: 'it', skipClosedPlaces: true };
    } else {
      const query = [name, city].filter(Boolean).join(' ').trim();
      if (!query) return undefined;
      input = { searchStringsArray: [query], maxCrawledPlacesPerSearch: 1, language: 'it', skipClosedPlaces: true };
    }
    const items = await this.runActorSync('maps', input, { maxItems: 1, timeoutMs: opts.timeoutMs });
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
      return u && !isGoogleMapsUrl(u) ? u : undefined;
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

  /**
   * ENRICH-3 — balance-sheet register lookup for ONE company by P.IVA.
   * Input shape is a probe-validated guess (`buildBilanciInput` is the single
   * place to fix if the actor's schema differs); result entity-guarded by the
   * calling stage. Uses run-sync (single company is fast).
   */
  async bilanciLookup(vat: string, opts: { timeoutMs?: number } = {}): Promise<BilanciRecord | undefined> {
    const q = (vat || '').replace(/\D/g, '');
    if (q.length !== 11) return undefined;
    const items = await this.runActorSync('bilanci', buildBilanciInput(q), { maxItems: null, timeoutMs: opts.timeoutMs ?? 180_000 });
    return items.length > 0 ? ApifyProvider.parseBilanciItem(items[0]) : undefined;
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
    // ENRICH-3 — the amministratore/titolare surfaces under different keys per
    // company form; also as the first entry of an `esponenti`-style array.
    let dmName = str(it.amministratore) ?? str(it.titolare) ?? str(it.legaleRappresentante) ?? str(it.rappresentante);
    let dmRole = dmName ? (str(it.caricaAmministratore) ?? (it.amministratore ? 'amministratore' : it.titolare ? 'titolare' : 'legale rappresentante')) : undefined;
    const esponenti = it.esponenti ?? it.exponents ?? it.cariche;
    if (!dmName && Array.isArray(esponenti) && esponenti.length > 0) {
      const e0 = (esponenti[0] ?? {}) as Record<string, unknown>;
      dmName = str(e0.nome) ?? str(e0.nominativo) ?? str(e0.name);
      dmRole = str(e0.carica) ?? str(e0.ruolo) ?? str(e0.role);
    }
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
      decision_maker_name: dmName,
      decision_maker_role: dmRole,
    };
  }

  /**
   * PURE parser for a jungle_synthesizer bilanci item (exposed for tests).
   * The actor has never run in this repo — key names are DEFENSIVE candidates
   * validated at probe time; unknown shapes degrade to an empty record, never
   * throw. `revenue` maps only from fatturato/ricavi keys, never from utile.
   */
  static parseBilanciItem(raw: unknown): BilanciRecord {
    const it = (raw ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
    const ateco = str(it.ateco) ?? ([str(it.atecoCode), str(it.atecoDescription)].filter(Boolean).join(' — ') || undefined);
    return {
      vat: (str(it.partitaIva) ?? str(it.piva) ?? str(it.vatNumber) ?? str(it.vat))?.replace(/\D/g, '') || undefined,
      name: str(it.denominazione) ?? str(it.ragioneSociale) ?? str(it.name) ?? str(it.companyName),
      pec: str(it.pec),
      revenue: str(it.fatturato) ?? str(it.ricavi) ?? str(it.revenue) ?? str(it.turnover),
      revenue_year: str(it.fatturatoAnno) ?? str(it.annoBilancio) ?? str(it.anno) ?? str(it.year),
      employees: str(it.dipendenti) ?? str(it.employees),
      share_capital: str(it.capitaleSociale) ?? str(it.shareCapital),
      legal_form: str(it.formaGiuridica) ?? str(it.legalForm),
      ateco,
      address: str(it.indirizzo) ?? str(it.address) ?? str(it.sede),
    };
  }

  /**
   * PURE parser for a pluggable email-verifier item (exposed for tests).
   * Maps the common marketplace vocabularies onto the four-state verdict;
   * anything unrecognized is `unknown` (never a false `invalid`).
   */
  static parseEmailVerifyItem(raw: unknown): EmailVerifyResult {
    const it = (raw ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined);
    const email = str(it.email) ?? str(it.address) ?? str(it.emailAddress);
    const verdictRaw = str(it.status) ?? str(it.result) ?? str(it.verdict) ?? str(it.state) ?? str(it.deliverability) ?? '';
    const catchAll = it.catchAll === true || it.catch_all === true || it.isCatchAll === true || /catch/.test(verdictRaw);
    let status: EmailVerifyResult['status'] = 'unknown';
    if (catchAll) status = 'catch_all';
    else if (/^(deliverable|valid|ok|safe|passed|exists?|good)$/.test(verdictRaw)) status = 'deliverable';
    else if (/^(undeliverable|invalid|bad|bounce[d]?|rejected|not?[_ ]?exists?|disabled)$/.test(verdictRaw)) status = 'invalid';
    else if (/^(risky|unknown|accept[_ ]?all|greylisted|timeout)$/.test(verdictRaw)) status = verdictRaw === 'accept_all' || verdictRaw === 'accept all' ? 'catch_all' : 'unknown';
    return { email, status };
  }
}
