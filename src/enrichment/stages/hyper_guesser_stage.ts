import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage } from '../../types/enrichment';
import type { StageOutcome } from '../../types/output';
import { ReasonCode as RC, DiscoveryMethod } from '../../types/output';
import { HyperGuesser } from '../../discovery/website/hyper_guesser';
import { rankCandidates } from '../../discovery/website/hyper_guesser/candidate_ranker';
import type { CandidateScore } from '../../discovery/website/hyper_guesser/candidate_ranker';
import { DEFAULTS } from '../../config/defaults';
import type { ProviderRouter } from '../../providers/provider_router';
import { verifyPlannedCandidates, routeFromLeadContext } from './verify_candidates';
import type { CandidateVerificationPlan } from './verify_candidates';

/**
 * Generate brand+city domain permutations, DNS-resolve, RANK, then
 * verify in tier order with a tier-aware retry budget.
 *
 * Phase D.4 change vs D.3:
 *   - alive candidates go through `rankCandidates` BEFORE any HTTP
 *   - top `strong`-tier candidates earn the full retry schedule
 *     (DEFAULTS.pipeline.verifyRetryDelaysMs)
 *   - `weak`-tier candidates get a single attempt only (no retry,
 *     no waiting) so a flapping homonym does not eat the per-stage
 *     wall-clock budget
 *   - `drop`-tier (score < DROP_THRESHOLD) candidates are dropped
 *     entirely from verification — they would never legitimately
 *     match the lead anyway (e.g. 2-3 char acronym domain)
 *
 * The rationale is that under noisy network the retry budget is the
 * scarce resource. Spending it on the top candidate first maximises
 * the chance of recovering a real TP.
 */
export class HyperGuesserStage implements Stage {
  readonly name = 'hyper_guesser';
  constructor(private router: ProviderRouter, private dnsResolver?: (host: string) => Promise<string[]>) {}

  async run(ctx: PerLeadContext, lead: Lead, normalized: NormalizedLead): Promise<StageOutcome> {
    const start = Date.now();
    const guesses = await HyperGuesser.run(normalized, { maxCandidates: 60, resolve4: this.dnsResolver });
    if (guesses.length === 0) {
      return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, reason_code: RC.NOT_FOUND_NO_CANDIDATES, detail: 'no_alive_domains' };
    }
    const ranked = rankCandidates(guesses, normalized);
    const verifiable = ranked.filter((s) => s.tier !== 'drop').slice(0, 6);

    if (verifiable.length === 0) {
      return {
        stage: this.name,
        status: 'not_found',
        duration_ms: Date.now() - start,
        reason_code: RC.NOT_FOUND_NO_CANDIDATES,
        detail: `alive=${guesses.length} all_dropped`,
      };
    }

    const plans: CandidateVerificationPlan[] = verifiable.map((s) => planFor(s));
    const verdict = await verifyPlannedCandidates(this.router, plans, normalized, lead, {
      // Guessed domains get a shorter timeout — a slow guess is almost never the
      // real site, and the full 8s timeout was the #1 wasted wall-time (log analysis).
      timeoutMs: DEFAULTS.pipeline.guessTimeoutMs,
      meta: { lead_id: ctx.leadId, run_id: ctx.runId, stage: this.name },
      fetchCache: ctx.httpFetchCache,
      route: routeFromLeadContext(ctx),
    });
    if (verdict.matched) {
      lead.website_discovery_method = DiscoveryMethod.HYPER_GUESSER;
      lead.website_confidence = verdict.confidence;
      const top = verifiable[0];
      return {
        stage: this.name,
        status: 'success',
        duration_ms: Date.now() - start,
        provider: verdict.provider,
        detail: `alive=${guesses.length} top=${top.domain}/${top.tier}/${top.score} ${verdict.detail ?? ''}`.trim(),
      };
    }
    return {
      stage: this.name,
      status: 'not_found',
      duration_ms: Date.now() - start,
      reason_code: RC.NOT_FOUND_NO_CANDIDATES,
      detail: `alive=${guesses.length} ranked_top=${verifiable.slice(0, 3).map((s) => `${s.domain}(${s.tier})`).join(',')}`,
    };
  }
}

/**
 * Tier → retry policy. Strong gets the global default (today
 * `[300, 1500]` with 2.5 s budget). Weak gets one attempt only.
 *
 * Strong-tier reasoning: the candidate domain matches the brand
 * (Layer A or B) — when the network blips, retrying is worth it
 * because we're confident the candidate is "the right one".
 *
 * Weak-tier reasoning: the candidate matched on weaker signals
 * (acronym only / single-token Italian word). On network flap,
 * spending more time here is a false economy — even if we recover
 * the fetch, the gate may still semantic-reject.
 */
function planFor(score: CandidateScore): CandidateVerificationPlan {
  if (score.tier === 'strong') {
    return {
      url: score.url,
      // Inherit DEFAULTS via undefined → caller falls back to global.
      rankScore: score.score,
      rankReasons: score.reasons,
    };
  }
  // weak
  return {
    url: score.url,
    retryDelaysMs: [],
    retryBudgetMs: 0,
    rankScore: score.score,
    rankReasons: score.reasons,
  };
}
