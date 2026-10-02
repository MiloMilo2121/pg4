import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage, StageRunOptions } from '../../types/enrichment';
import type { StageOutcome, ReasonCode } from '../../types/output';
import { ReasonCode as RC, DiscoveryMethod } from '../../types/output';
import { InputWebsiteCandidate, domainMatchesCompanyName } from '../../discovery/website/input_website_candidate';
import { DEFAULTS } from '../../config/defaults';
import type { ProviderRouter } from '../../providers/provider_router';
import { verifyCandidates, routeFromLeadContext } from '../website/verify_candidates';
import { getEnv } from '../../config/env';

/** Verify the input `website` field via direct_fetch + PreVerifyGate. */
export class InputWebsiteStage implements Stage {
  readonly name = 'input_website';
  constructor(private router: ProviderRouter) {}

  async run(ctx: PerLeadContext, lead: Lead, normalized: NormalizedLead, opts: StageRunOptions = {}): Promise<StageOutcome> {
    const start = Date.now();
    const website = normalized.website;
    if (!website) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, reason_code: RC.NOT_FOUND_NO_CANDIDATES, detail: 'no_input_website' };
    }
    const assessed = InputWebsiteCandidate.assess(website);
    if (assessed.classification !== 'VALID') {
      return {
        stage: this.name,
        status: 'not_found',
        duration_ms: Date.now() - start,
        reason_code: (assessed.reason_code as ReasonCode) ?? RC.INPUT_WEBSITE_INVALID,
        detail: `classification=${assessed.classification}`,
      };
    }
    const verdict = await verifyCandidates(this.router, assessed.candidates.slice(0, 3), normalized, lead, {
      timeoutMs: DEFAULTS.pipeline.requestTimeoutMs,
      meta: { lead_id: ctx.leadId, run_id: ctx.runId, stage: this.name },
      signal: opts.signal,
      fetchCache: ctx.httpFetchCache,
      route: routeFromLeadContext(ctx),
    });
    if (verdict.matched) {
      lead.website_discovery_method = verdict.method === 'piva' ? DiscoveryMethod.INPUT_PIVA_MATCH : DiscoveryMethod.INPUT_SEMANTIC;
      lead.website_confidence = verdict.confidence;
      if (verdict.body) ctx.verifiedBody = verdict.body; // free-gold seam
      return { stage: this.name, status: 'success', duration_ms: Date.now() - start, provider: verdict.provider, detail: verdict.detail };
    }
    // NAME-MATCH recovery (flag-gated, free): content-verify rejected it, but the
    // distinctive company name is embedded in the domain (immobiliareziero.it ↔
    // "Immobiliare Ziero"). Accept the site at a modest confidence so DEEP_PAGES
    // can mine it; no body captured here, so the deep pass re-fetches it.
    if (getEnv().INPUT_WEBSITE_NAME_MATCH_ENABLED && domainMatchesCompanyName(assessed.normalized_url ?? website, lead.company_name)) {
      lead.official_website = assessed.normalized_url ?? assessed.candidates[0] ?? website;
      lead.website_discovery_method = DiscoveryMethod.INPUT_DOMAIN_NAME_MATCH;
      lead.website_confidence = DEFAULTS.scoring.nameMatchConfidence;
      return { stage: this.name, status: 'success', duration_ms: Date.now() - start, detail: `domain_name_match:${lead.official_website}` };
    }
    return {
      stage: this.name,
      status: 'not_found',
      duration_ms: Date.now() - start,
      reason_code: verdict.timedOut ? RC.INPUT_WEBSITE_TIMEOUT : RC.INPUT_WEBSITE_NOT_VERIFIED,
      detail: verdict.detail,
    };
  }
}
