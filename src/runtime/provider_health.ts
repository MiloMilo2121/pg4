import { logger } from './logger';
import { getNotifier } from './notifier';
import type { CostLedger } from './cost_ledger';

/**
 * Gate-0 — the silent-dead-provider detector.
 *
 * THE meta-lesson of every prior pass: dns_mx + crtsh made 0 successful
 * calls in 12,728 attempts and nobody noticed for months, because a
 * provider that always fails is silent — it just adds latency. This makes
 * that failure class STRUCTURALLY self-reporting: any provider that made
 * at least `minCalls` calls in a run and succeeded ZERO times is flagged
 * loudly in the run summary, recorded on the run record, and pushed to the
 * operator notifier. A new dead provider can never again hide.
 *
 * Success semantics (from `ProviderRouter`): `success=true` means the
 * provider returned a usable response — NOT that the response converted to
 * a verified website. So a SERP provider that returns results which the
 * verifier later rejects still counts as a success here; only a provider
 * that never returns anything usable (empty / blocked / transport / timeout
 * on every call) trips the detector. That is exactly the dead-provider
 * signal and nothing else.
 */

export const DEAD_PROVIDER_MIN_CALLS = 10;

export interface DeadProvider {
  provider: string;
  calls: number;
  /** Dominant failure kind across the run (e.g. 'empty', 'transport'). */
  dominant_kind: string;
}

type ByProvider = Record<
  string,
  { calls: number; cost_eur: number; success_rate: number; by_kind: Record<string, number> }
>;

/**
 * Pure detector. Returns the providers that made ≥ `minCalls` calls and
 * had a 0% success rate, with the failure kind that dominated.
 */
export function detectDeadProviders(byProvider: ByProvider, minCalls: number = DEAD_PROVIDER_MIN_CALLS): DeadProvider[] {
  const dead: DeadProvider[] = [];
  for (const [provider, stats] of Object.entries(byProvider)) {
    if (stats.calls < minCalls) continue;
    if (stats.success_rate > 0) continue;
    // Dominant failure kind (excluding the impossible 'success' since rate is 0).
    let dominant = 'other';
    let max = -1;
    for (const [kind, n] of Object.entries(stats.by_kind)) {
      if (kind === 'success') continue;
      if (n > max) {
        max = n;
        dominant = kind;
      }
    }
    dead.push({ provider, calls: stats.calls, dominant_kind: dominant });
  }
  return dead.sort((a, b) => b.calls - a.calls);
}

/**
 * Run the detector against a ledger and report. Warn-only: it never changes
 * the run outcome, exactly like post-run validation. Logs a loud warning,
 * pushes a notifier event, and returns the dead-provider id list for the
 * caller to stamp on the run record. Empty list → silent (nothing dead).
 */
export function reportProviderHealth(
  ledger: CostLedger,
  opts: { runId?: string; minCalls?: number } = {}
): string[] {
  let dead: DeadProvider[];
  try {
    dead = detectDeadProviders(ledger.getByProvider(), opts.minCalls);
  } catch (err) {
    // Diagnostics must never take a run down.
    logger.warn({ err: (err as Error).message }, '[provider-health] detector errored (non-fatal)');
    return [];
  }
  if (dead.length === 0) return [];

  const ids = dead.map((d) => d.provider);
  logger.warn(
    { provider_dead: dead, run_id: opts.runId },
    `[provider-health] ⚠ ${dead.length} provider(s) made calls but NEVER succeeded this run — ` +
      `${dead.map((d) => `${d.provider}(${d.calls} calls, all ${d.dominant_kind})`).join(', ')}. ` +
      `Investigate or remove — this is the dns_mx/crtsh silent-failure class.`
  );
  getNotifier().notify({
    kind: 'provider_dead',
    title: 'Dead provider detected',
    body:
      `${dead.length} provider(s) with 0% success after ≥${opts.minCalls ?? DEAD_PROVIDER_MIN_CALLS} calls: ` +
      `${ids.join(', ')}. They add latency with no yield.`,
    meta: { run_id: opts.runId, providers: ids.join(',') },
  });
  return ids;
}
