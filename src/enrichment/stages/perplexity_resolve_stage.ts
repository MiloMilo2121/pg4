import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage } from '../../types/enrichment';
import type { StageOutcome } from '../../types/output';
import { DiscoveryMethod } from '../../types/output';
import type { ProviderRouter } from '../../providers/provider_router';
import { verifyCandidates } from './verify_candidates';
import { matchSocialUrl, type SocialKey } from '../extract/extract_from_body';
import { normalizeVatCode, validateItalianVatChecksum } from '../financial/vat';
import { getEnv } from '../../config/env';

/** A social URL that passes host + path + handle-charset validation, or undefined. */
function validatedSocial(url: string): { key: SocialKey; url: string } | undefined {
  const m = matchSocialUrl(url.trim());
  if (!m) return undefined;
  // Instagram/TikTok handles are a single segment of [a-z0-9._]; reject the rest
  // (hyphenated/spaced/multi-segment strings the LLM sometimes invents).
  if (m.key === 'instagram' || m.key === 'tiktok') {
    let seg = '';
    try {
      seg = new URL(m.url).pathname.replace(/^\/@?/, '').replace(/\/$/, '');
    } catch {
      return undefined;
    }
    if (!/^[a-z0-9._]{1,40}$/i.test(seg)) return undefined;
  }
  return m;
}

/**
 * Perplexity Sonar entity-resolution — LAST-RESORT discovery (PAID, default-OFF).
 * Runs only for leads the free ladder + Maps left WITHOUT a website. Sonar does a
 * live web search and proposes {website, socials, vat, sources}; we then HARD-GUARD
 * the proposed website through the existing `verifyCandidates` ladder (a
 * hallucinated or namesake site fails the semantic match on fetch and is refused).
 * Goes through `router.complete` so the same paid-gate / budget / run-ceiling /
 * ledger apply. Never throws.
 */
export class PerplexityResolveStage implements Stage {
  readonly name = 'perplexity_resolve';

  constructor(private router: ProviderRouter) {}

  async run(ctx: PerLeadContext, lead: Lead, normalized: NormalizedLead): Promise<StageOutcome> {
    const start = Date.now();
    if (getEnv().PERPLEXITY_RESOLVE_ENABLED !== true) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'perplexity_resolve_disabled' };
    }
    // Last-resort: run when the lead is still missing a website OR has no social
    // presence at all (Sonar is a strong social finder for IT SMBs). A lead that
    // already has both a website and a social is left alone (no spend).
    const hasWebsite = !!lead.official_website;
    const hasAnySocial = !!(lead.instagram || lead.facebook || lead.linkedin || lead.tiktok || lead.youtube);
    if (hasWebsite && hasAnySocial) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'already_has_website_and_social' };
    }

    const name = (lead.company_name as string | undefined)?.trim();
    if (!name) return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'no_company_name' };
    const city = (lead.city as string | undefined) ?? (lead.business_city as string | undefined) ?? (lead.query_location as string | undefined) ?? '';
    const remaining = (ctx.costCeilingEur ?? 0) - ctx.costEur;

    const content = await this.router.complete(
      {
        system: 'Sei un risolutore preciso di dati aziendali italiani. Usa la ricerca web live. Rispondi SOLO con un oggetto JSON, senza prosa.',
        prompt:
          `Trova i dati ufficiali di questa azienda italiana.\n` +
          `Azienda: "${name}". Località: "${city}".\n` +
          `Restituisci JSON: {"website": url|null, "instagram": url|null, "facebook": url|null, ` +
          `"linkedin": url|null, "tiktok": url|null, "youtube": url|null, "vat": "P.IVA 11 cifre"|null, "sources": [url,...]}.\n` +
          `Includi un valore SOLO se sei sicuro che sia QUESTA azienda (non un omonimo). Usa null se incerto.`,
        max_tokens: 500,
        temperature: 0,
      },
      {
        paidEnabled: ctx.paidEnabled === true,
        includeProviderIds: ['perplexity'],
        remainingLeadBudgetEur: remaining,
        runCostCeilingEur: ctx.runCostCeilingEur,
        meta: { lead_id: ctx.leadId, run_id: ctx.runId ?? '', stage: this.name },
      },
    );
    if (!content) return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, detail: 'gated_or_no_completion' };

    const parsed = parseResolution(content.content);
    if (!parsed) return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, provider: 'perplexity', detail: 'unparseable_json' };

    const filled: string[] = [];
    // ---- website: HARD-GUARD via verifyCandidates (anti-hallucination). On a
    // positive verdict the verifier itself sets lead.official_website; we just
    // stamp the provenance + capture the body for the free-gold seam. Only when
    // the lead still lacks a website (if it has one, we ran purely for socials). ----
    if (!hasWebsite && parsed.website) {
      try {
        const verdict = await verifyCandidates(this.router, [parsed.website], normalized, lead, {
          timeoutMs: 8000,
          meta: { lead_id: ctx.leadId, run_id: ctx.runId ?? '', stage: this.name },
          fetchCache: ctx.httpFetchCache,
        });
        if (verdict.matched) {
          lead.website_discovery_method = DiscoveryMethod.PERPLEXITY_RESOLVED;
          lead.website_confidence = verdict.confidence ?? 0.7;
          if (verdict.body) ctx.verifiedBody = verdict.body;
          filled.push('official_website');
        }
      } catch {
        /* verify failed → website not asserted */
      }
    }
    // ---- socials: fill-only-missing, VALIDATED via matchSocialUrl + a handle
    // sanity check (Perplexity sometimes constructs malformed handles like
    // "mediaCasa-immobiliare-padova" — rejected; an unverifiable namesake is
    // worse than an empty cell). ----
    for (const key of ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube'] as const) {
      const v = parsed[key];
      if (typeof v !== 'string' || !v || (lead as Record<string, unknown>)[key]) continue;
      const valid = validatedSocial(v);
      if (valid && valid.key === key) {
        (lead as Record<string, unknown>)[key] = valid.url;
        filled.push(key);
      }
    }
    // ---- vat: checksum-validate before trusting ----
    if (parsed.vat && !lead.vat_code_final) {
      const v = normalizeVatCode(parsed.vat);
      if (/^\d{11}$/.test(v) && validateItalianVatChecksum(v)) {
        lead.vat_code_final = v;
        filled.push('vat_code_final');
      }
    }

    return {
      stage: this.name,
      status: filled.length > 0 ? 'success' : 'not_found',
      duration_ms: Date.now() - start,
      provider: 'perplexity',
      detail: filled.length > 0 ? `filled=${filled.join(',')}` : 'no_verified_fields',
    };
  }
}

interface Resolution {
  website?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  tiktok?: string | null;
  youtube?: string | null;
  vat?: string | null;
  sources?: unknown;
}

/** Parse the LLM's JSON answer, tolerating ```json fences and surrounding prose. */
function parseResolution(content: string): Resolution | undefined {
  if (!content) return undefined;
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const obj = s.match(/\{[\s\S]*\}/);
  if (!obj) return undefined;
  try {
    const j = JSON.parse(obj[0]) as Resolution;
    return j && typeof j === 'object' ? j : undefined;
  } catch {
    return undefined;
  }
}

export { parseResolution, validatedSocial };
