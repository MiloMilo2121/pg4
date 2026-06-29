import { request } from 'undici';
import { getEnv } from '../../config/env';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { RateLimiter } from '../../runtime/rate_limiter';
import { normalizeVatCode, validateItalianVatChecksum } from '../../enrichment/financial/vat';

/**
 * Openapi.com — official Italian company registry (InfoCamere reseller, ANCIC).
 * The REQUEST BASE + connection. PAID and DISABLED by default — this client only
 * makes a call when `available()` (OPENAPI_ENABLED + key) AND a caller explicitly
 * invokes it. The "only top companies, on request" policy is enforced by the
 * ACTIVATION LAYER on top of this (see docs/openapi_layer_rules.md) — this module
 * is the plumbing, not the policy.
 *
 * Auth: Bearer token (the OPENAPI_API_KEY is Openapi's scoped token). Base URL:
 * company.openapi.com (prod) / test.company.openapi.com (sandbox via OPENAPI_BASE_URL).
 *
 * SHAPE STATUS (2026-06-16): IT-search request params + the "Start" response fields
 * (vatCode, companyName, taxCode, address.registeredOffice.{town,province},
 * activityStatus) are from the published docs. The per-VAT /IT-advanced + /IT-pec
 * response FIELD PATHS (revenue/employees/legal-rep/PEC) are NOT yet verified against
 * a live response — they are marked PENDING and MUST be confirmed + golden'd from the
 * first real call before the paid tiers are enabled. No invented-shape golden ships
 * (the project rule that caught 6 bugs).
 */

const limiter = new RateLimiter();
// Openapi allows 10k/min; we stay a good citizen. The real spend bound is the
// per-request ceiling + the activation layer, not this — capacity 5, ~5/s.
limiter.configure('openapi', 5, 5);

export interface OpenapiAddress {
  town?: string;
  province?: string;
  zipCode?: string;
}

/** Normalised subset of an Openapi company record (camelCase mirrors the API). */
export interface OpenapiCompany {
  vatCode?: string;
  taxCode?: string;
  companyName?: string;
  ateco?: string;
  address?: OpenapiAddress;
  activityStatus?: string;
  /** PENDING real-shape verification (advanced enrichment). */
  revenue?: number;
  revenueYear?: string;
  employees?: string;
  legalRep?: string;
  pec?: string;
  /** The raw record, so callers can finalise field paths once the live shape is seen. */
  raw?: unknown;
}

export type Enrichment = 'Name' | 'PEC' | 'Address' | 'Start' | 'Advanced';

export class OpenapiClient {
  readonly id = 'openapi';

  /** Triple-gate part 1+2: enabled flag + key present. (Ceiling is the caller's gate.) */
  available(): boolean {
    const e = getEnv();
    return e.OPENAPI_ENABLED === true && typeof e.OPENAPI_API_KEY === 'string' && e.OPENAPI_API_KEY.length > 0;
  }

  private baseUrl(): string {
    return getEnv().OPENAPI_BASE_URL.replace(/\/$/, '');
  }

  /**
   * Low-level GET with Bearer auth, error classification (mirrors serper.ts so the
   * breaker/ledger treat auth/rate/5xx as failures, not "empty success"), and a
   * good-citizen rate-limit. Returns parsed JSON or throws.
   */
  private async get(path: string, query: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    const e = getEnv();
    const apiKey = e.OPENAPI_API_KEY;
    if (!apiKey) throw new ProviderBlockError(this.id, 'openapi key missing'); // available() should have prevented this
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.baseUrl()}${path}${qs ? `?${qs}` : ''}`;

    await limiter.acquire('openapi');
    let res;
    try {
      res = await request(url, {
        method: 'GET',
        bodyTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        headersTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': DEFAULTS.http.userAgent },
      });
    } catch (err) {
      throw err; // network/timeout → transport (not silent-empty)
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `openapi auth failure (${res.statusCode})`); // bad/expired key
    }
    if (res.statusCode === 429) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, 'openapi rate limit (429)');
    }
    if (res.statusCode < 200 || res.statusCode >= 400) {
      await res.body.dump();
      throw new Error(`openapi http ${res.statusCode}`);
    }
    try {
      return await res.body.json();
    } catch (err) {
      throw new Error(`openapi json parse: ${(err as Error).message}`);
    }
  }

  /**
   * IT-search by ATECO + province (the legal-universe enumerator). `dryRun:true`
   * returns a COUNT only (free ≤100/day) — use it for segment sizing at €0. Without
   * dryRun it returns company records (€0.01/req beyond the free quota). `enrichment`
   * selects the response dataset (Start = identity + official VAT + address).
   * Returns the raw payload; mapping helpers below normalise it.
   */
  async searchByAtecoProvince(
    ateco: string,
    provincia: string,
    opts: { dryRun?: boolean; enrichment?: Enrichment; limit?: number; skip?: number } = {},
  ): Promise<unknown> {
    return this.get('/IT-search', {
      ateco,
      province: provincia,
      dryRun: opts.dryRun ? true : undefined,
      dataEnrichment: opts.enrichment,
      limit: opts.limit,
      skip: opts.skip,
    });
  }

  /**
   * Advanced firmographics by VAT (revenue / employees / legal representative / REA).
   * PENDING: confirm the exact path + response field paths against the first real call.
   * The entity-guard (isWrongEntity on the returned companyName) is applied by the
   * CALLER (the cascade step), not here — this is plumbing.
   */
  async advancedByVat(rawVat: string | undefined): Promise<OpenapiCompany | undefined> {
    const vat = normalizeVatCode(rawVat);
    if (!/^\d{11}$/.test(vat) || !validateItalianVatChecksum(vat)) return undefined;
    const json = await this.get(`/IT-advanced/${vat}`, {}); // PENDING: confirm path shape
    return mapAdvanced(json);
  }

  /** Certified email (PEC) by VAT. PENDING response-field verification. */
  async pecByVat(rawVat: string | undefined): Promise<string | undefined> {
    const vat = normalizeVatCode(rawVat);
    if (!/^\d{11}$/.test(vat) || !validateItalianVatChecksum(vat)) return undefined;
    const json = await this.get(`/IT-pec/${vat}`, {}); // PENDING: confirm path shape
    const rec = unwrap(json);
    return rec ? str(pick(rec, 'pec') ?? pick(rec, 'digitalAddress')) : undefined;
  }
}

type Rec = Record<string, unknown>;
function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object';
}
function pick(r: Rec, key: string): unknown {
  return r[key];
}
/** Openapi wraps records as `{ data: {...} }` (common) or returns the record directly. */
function unwrap(json: unknown): Rec | undefined {
  if (!isRec(json)) return undefined;
  const data = json.data ?? json;
  return isRec(data) ? data : undefined;
}

/**
 * Map an /IT-advanced record to OpenapiCompany. The identity fields (vatCode,
 * companyName, address) follow the documented IT-search "Start" shape; the
 * firmographic paths (turnover/employees/legal rep) are best-effort and MUST be
 * confirmed against a real response before the paid tier is enabled. Always keeps
 * `raw` so the first real call can finalise the paths.
 */
export function mapAdvanced(json: unknown): OpenapiCompany | undefined {
  const r = unwrap(json);
  if (!r) return undefined;
  const addr = isRec(r.address) ? r.address : {};
  const office: Rec = isRec(addr.registeredOffice) ? addr.registeredOffice : isRec(r.registeredOffice) ? r.registeredOffice : {};
  return {
    vatCode: str(r.vatCode),
    taxCode: str(r.taxCode),
    companyName: str(pick(r, 'companyName') ?? pick(r, 'denomination') ?? pick(r, 'denominazione')),
    ateco: str(pick(r, 'ateco') ?? pick(r, 'atecoCode')),
    address: { town: str(pick(office, 'town') ?? pick(office, 'comune')), province: str(pick(office, 'province') ?? pick(office, 'provincia')), zipCode: str(office.zipCode) },
    activityStatus: str(pick(r, 'activityStatus') ?? pick(r, 'status')),
    revenue: num(pick(r, 'turnover') ?? pick(r, 'revenue') ?? pick(r, 'fatturato')), // PENDING field name
    revenueYear: str(pick(r, 'balanceYear') ?? pick(r, 'revenueYear')),
    employees: str(pick(r, 'employees') ?? pick(r, 'dipendenti')),
    legalRep: str(pick(r, 'legalRepresentative') ?? pick(r, 'rappresentanteLegale')),
    pec: str(pick(r, 'pec') ?? pick(r, 'digitalAddress')),
    raw: json,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
