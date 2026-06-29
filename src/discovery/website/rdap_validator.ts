import { request } from 'undici';
import type { NormalizedLead } from '../../types/discovery';
import { DEFAULTS } from '../../config/defaults';

export interface RdapEvidence {
  confidence: number;            // 0..1
  evidence: 'piva_in_payload' | 'name_in_vcard' | 'name_in_payload' | 'none';
  detail?: string;
  /**
   * Phase D: explicit registrant mismatch — true when RDAP returns a
   * registrant whose locality / region / country contradicts the
   * lead's. Backward-compatible (optional). Used by `verify_candidates`
   * to veto a `VERIFIED_SEMANTIC` decision.
   */
  mismatch?: boolean;
  mismatch_reason?: string;
}

/**
 * RDAP/WHOIS validator. Probes a domain's RDAP record and checks whether
 * the registrant identity matches the company.
 *
 * Free, deterministic, low-volume API. Uses rdap.nic.it for `.it` (faster
 * and more authoritative) and rdap.org for everything else.
 */
export class RdapValidator {
  /**
   * Live network probe. Returns confidence 0..1.
   * 0.9 = P.IVA found in JSON payload (golden signal)
   * 0.4 = strong vCard name match
   * 0.2 = weak/raw name match
   * 0.0 = no signal / 4xx / unreachable
   */
  static async checkDomainOwnership(domain: string, lead: NormalizedLead, opts: { signal?: AbortSignal } = {}): Promise<RdapEvidence> {
    const cleanDomain = this.normalizeDomainInput(domain);
    if (!cleanDomain) return { confidence: 0, evidence: 'none', detail: 'invalid_domain_input' };
    const tld = cleanDomain.split('.').pop();
    const endpoint = tld === 'it'
      ? `https://rdap.nic.it/domain/${cleanDomain}`
      : `https://rdap.org/domain/${cleanDomain}`;

    try {
      const res = await request(endpoint, {
        method: 'GET',
        bodyTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        headersTimeout: DEFAULTS.pipeline.requestTimeoutMs,
        signal: opts.signal,
        headers: { accept: 'application/rdap+json', 'user-agent': DEFAULTS.http.userAgent },
        maxRedirections: 3,
      });
      if (res.statusCode !== 200) {
        await res.body.dump();
        return { confidence: 0, evidence: 'none', detail: `http_${res.statusCode}` };
      }
      const data = await res.body.json();
      return this.score(data, lead);
    } catch (err) {
      return { confidence: 0, evidence: 'none', detail: `error_${(err as Error).message}` };
    }
  }

  /** Pure scorer — exposed for unit tests. */
  static score(payload: unknown, lead: NormalizedLead): RdapEvidence {
    if (!payload || typeof payload !== 'object') return { confidence: 0, evidence: 'none' };
    const json = JSON.stringify(payload).toLowerCase();

    // P.IVA in payload (golden) — even short-circuits the mismatch check.
    const piva = (lead.vat_code ?? '').replace(/\D/g, '');
    if (piva.length === 11 && json.includes(piva)) {
      return { confidence: 0.9, evidence: 'piva_in_payload', detail: `piva=${piva}` };
    }

    // Phase D: detect explicit mismatch from registrant locality / region /
    // country fields. Used by the verify_candidates layer to veto a
    // semantic-only acceptance when the registrant is clearly elsewhere.
    const mismatch = this.detectMismatch(payload, lead);

    // vCard name match
    const entities = ((payload as Record<string, unknown>).entities ?? []) as unknown[];
    if (Array.isArray(entities)) {
      for (const e of entities) {
        const ent = e as { vcardArray?: unknown };
        const vcard = ent.vcardArray;
        if (!Array.isArray(vcard) || vcard.length < 2 || !Array.isArray(vcard[1])) continue;
        for (const entry of vcard[1] as unknown[]) {
          if (!Array.isArray(entry)) continue;
          const [key, , , value] = entry as [string, unknown, unknown, unknown];
          if (key !== 'fn' && key !== 'org') continue;
          const registrant = `${value ?? ''}`.toLowerCase();
          const score = this.scoreNameMatch(lead.company_name, registrant);
          if (score >= 0.6) return { confidence: 0.4, evidence: 'name_in_vcard', detail: `name="${registrant}" score=${score.toFixed(2)}`, ...mismatch };
          if (score >= 0.4) return { confidence: 0.2, evidence: 'name_in_vcard', detail: `name="${registrant}" weak=${score.toFixed(2)}`, ...mismatch };
        }
      }
    }

    // Raw payload fallback
    const rawScore = this.scoreNameMatch(lead.company_name, json);
    if (rawScore >= 0.8) return { confidence: 0.2, evidence: 'name_in_payload', detail: `raw_score=${rawScore.toFixed(2)}`, ...mismatch };

    return { confidence: 0, evidence: 'none', ...mismatch };
  }

  /**
   * Inspect RDAP entities' vCard `adr` arrays for an explicit registrant
   * locality/region/country that contradicts the lead. Conservative —
   * returns mismatch only when there's a positive signal that the
   * registrant is ELSEWHERE; missing data is never a mismatch.
   *
   * vCard `adr` shape per RFC 6350:
   *   ["adr", {...params}, "text", [pobox, ext, street, locality, region, postcode, country]]
   */
  private static detectMismatch(
    payload: unknown,
    lead: NormalizedLead
  ): { mismatch?: boolean; mismatch_reason?: string } {
    const leadProvince = (lead.province ?? '').toUpperCase();
    const leadCity = (lead.city ?? '').toLowerCase();
    const leadBusinessCity = '';

    const entities = ((payload as Record<string, unknown>).entities ?? []) as unknown[];
    if (!Array.isArray(entities)) return {};

    for (const e of entities) {
      const ent = e as { vcardArray?: unknown };
      const vcard = ent.vcardArray;
      if (!Array.isArray(vcard) || vcard.length < 2 || !Array.isArray(vcard[1])) continue;
      for (const entry of vcard[1] as unknown[]) {
        if (!Array.isArray(entry)) continue;
        const [key, , , value] = entry as [string, unknown, unknown, unknown];
        if (key !== 'adr') continue;
        const adr = Array.isArray(value) ? (value as unknown[]) : null;
        if (!adr || adr.length < 7) continue;
        const locality = `${adr[3] ?? ''}`.toLowerCase().trim();
        const region = `${adr[4] ?? ''}`.toUpperCase().trim();
        const country = `${adr[6] ?? ''}`.toUpperCase().trim();

        // Country mismatch is the strongest signal.
        if (country && country !== 'IT' && country !== 'ITA' && country !== 'ITALY') {
          return { mismatch: true, mismatch_reason: `registrant_country=${country}` };
        }
        // Italian region (province sigla) mismatch when both sides are populated.
        if (region && leadProvince && region.length === 2 && region !== leadProvince) {
          return { mismatch: true, mismatch_reason: `registrant_region=${region} lead=${leadProvince}` };
        }
        // Locality mismatch: registrant locality is a different Italian city
        // and the lead has a clear locality of its own.
        if (locality && (leadCity || leadBusinessCity)) {
          const leadLoc = leadBusinessCity || leadCity;
          if (locality.length >= 3 && leadLoc.length >= 3 && !locality.includes(leadLoc) && !leadLoc.includes(locality)) {
            // Soft mismatch — only emit when paired with no other anchor.
            return { mismatch: true, mismatch_reason: `registrant_locality="${locality}" lead="${leadLoc}"` };
          }
        }
      }
    }
    return {};
  }

  /** Cosine-ish token overlap: |intersection| / |smaller_set|. */
  private static scoreNameMatch(name: string, target: string): number {
    if (!name || !target) return 0;
    const tokens = name
      .toLowerCase()
      .replace(/s\.?r\.?l\.?(s)?|s\.?p\.?a\.?|s\.?n\.?c\.?|s\.?a\.?s\.?|scarl|srls|unipersonale|in liquidazione/gi, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    if (tokens.length === 0) return 0;
    const lower = target.toLowerCase();
    const matched = tokens.filter((t) => lower.includes(t));
    return matched.length / tokens.length;
  }

  private static normalizeDomainInput(input: string): string | undefined {
    if (!input) return undefined;
    let s = input.trim().toLowerCase();
    if (s.startsWith('http://') || s.startsWith('https://')) {
      try { s = new URL(s).hostname; } catch { return undefined; }
    }
    s = s.replace(/^www\./, '').replace(/\/.*$/, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : undefined;
  }
}
