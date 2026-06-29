import { request } from 'undici';
import type { CostedMeta, ProviderRole } from '../../types/providers';
import { ProviderBlockError } from '../../types/providers';
import { DEFAULTS } from '../../config/defaults';
import { getEnv } from '../../config/env';

/**
 * Hunter.io — EMAIL_FIND / EMAIL_VERIFY / B2B_CONTACT / DECISION_MAKER. Non-router
 * family ('email'): callers MUST invoke it through `ProviderRouter.invoke(meta, …)`
 * so the SAME paid-gate / budget / run-ceiling / breaker / ledger apply (addendum R1 —
 * no cost-safety bypass). Each op exposes its own CostedMeta (finder/domain = 1 credit
 * ≈ €0.04, verifier = 0.5 credit ≈ €0.02). Tier 2 / paid, OFF by default.
 *
 * Endpoints (GET, api_key query): /v2/domain-search · /v2/email-finder · /v2/email-verifier.
 * Spec: docs/provider_integration_specs.md#Hunter.io.
 */
export type HunterOp = 'find' | 'verify' | 'domain';

export interface HunterEmail {
  value: string;
  type?: string;
  confidence?: number;
  first_name?: string;
  last_name?: string;
  position?: string;
}

const ROLES: ReadonlyArray<ProviderRole> = ['EMAIL_FIND', 'EMAIL_VERIFY', 'B2B_CONTACT', 'DECISION_MAKER'];
const COST: Record<HunterOp, number> = { find: 0.04, domain: 0.04, verify: 0.02 };

export class HunterProvider {
  readonly id = 'hunter';
  readonly family = 'email' as const;
  readonly roles = ROLES;

  available(): boolean {
    const e = getEnv();
    return e.HUNTER_ENABLED === true && typeof e.HUNTER_API_KEY === 'string' && e.HUNTER_API_KEY.length > 0;
  }

  /** The cost-gated descriptor for a given op — pass to router.invoke for spend safety. */
  meta(op: HunterOp): CostedMeta {
    const available = () => this.available();
    return { id: this.id, family: this.family, tier: 2, costPerCallEur: COST[op], available, roles: this.roles };
  }

  private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const e = getEnv();
    const apiKey = e.HUNTER_API_KEY;
    if (!apiKey) throw new ProviderBlockError(this.id, 'hunter key missing');
    const qs = new URLSearchParams({ ...params, api_key: apiKey }).toString();
    const url = `https://api.hunter.io/v2/${path}?${qs}`;
    const res = await request(url, {
      method: 'GET',
      bodyTimeout: DEFAULTS.pipeline.requestTimeoutMs,
      headersTimeout: DEFAULTS.pipeline.requestTimeoutMs,
      signal,
      headers: { accept: 'application/json', 'user-agent': DEFAULTS.http.userAgent },
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, `hunter auth failure (${res.statusCode})`);
    }
    if (res.statusCode === 429) {
      await res.body.dump();
      throw new ProviderBlockError(this.id, 'hunter rate limit (429)');
    }
    // 202 = verification still running; treat the (partial) body as the result.
    if (res.statusCode < 200 || (res.statusCode >= 300 && res.statusCode !== 202)) {
      await res.body.dump();
      throw new Error(`hunter http ${res.statusCode}`);
    }
    return res.body.json();
  }

  /** EMAIL_FIND — most-likely email for a person at a domain. */
  async emailFinder(domain: string, firstName: string, lastName: string, signal?: AbortSignal): Promise<{ email?: string; score?: number }> {
    const json = await this.get('email-finder', { domain, first_name: firstName, last_name: lastName }, signal);
    return HunterProvider.parseFinder(json);
  }

  /** B2B_CONTACT / EMAIL_FIND — all emails for a domain (decision-maker roles surface here). */
  async domainSearch(domain: string, limit = 10, signal?: AbortSignal): Promise<HunterEmail[]> {
    const json = await this.get('domain-search', { domain, limit: String(limit) }, signal);
    return HunterProvider.parseDomainSearch(json);
  }

  /** EMAIL_VERIFY — deliverability status for an address. */
  async emailVerifier(email: string, signal?: AbortSignal): Promise<{ status?: string; score?: number }> {
    const json = await this.get('email-verifier', { email }, signal);
    return HunterProvider.parseVerifier(json);
  }

  // ---- pure parsers (exposed for tests) ----
  static parseFinder(json: unknown): { email?: string; score?: number } {
    const d = (json as { data?: { email?: unknown; score?: unknown } })?.data;
    return { email: typeof d?.email === 'string' ? d.email : undefined, score: typeof d?.score === 'number' ? d.score : undefined };
  }
  static parseVerifier(json: unknown): { status?: string; score?: number } {
    const d = (json as { data?: { status?: unknown; score?: unknown } })?.data;
    return { status: typeof d?.status === 'string' ? d.status : undefined, score: typeof d?.score === 'number' ? d.score : undefined };
  }
  static parseDomainSearch(json: unknown): HunterEmail[] {
    const emails = (json as { data?: { emails?: unknown } })?.data?.emails;
    if (!Array.isArray(emails)) return [];
    return emails
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { value?: unknown }).value === 'string')
      .map((e) => ({
        value: e.value as string,
        type: typeof e.type === 'string' ? e.type : undefined,
        confidence: typeof e.confidence === 'number' ? e.confidence : undefined,
        first_name: typeof e.first_name === 'string' ? e.first_name : undefined,
        last_name: typeof e.last_name === 'string' ? e.last_name : undefined,
        position: typeof e.position === 'string' ? e.position : undefined,
      }));
  }
}
