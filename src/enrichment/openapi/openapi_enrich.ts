import { OpenapiClient } from '../../providers/openapi/openapi_client';
import type { OpenapiCompany } from '../../providers/openapi/openapi_client';
import { isWrongEntity } from '../fields/field_registry';
import type { CostLedger } from '../../runtime/cost_ledger';

/**
 * THE CONNECTION ("il collegamento") between pg4 and Openapi — the single gated entry
 * point the ACTIVATION LAYER (and the dashboard "deep enrich" action) will call.
 *
 * What this enforces NOW (the base):
 *   - DISABLED by default — returns `{ ok:false, reason:'disabled' }` unless
 *     OPENAPI_ENABLED + key (client.available()).
 *   - ENTITY-GUARD — the official record's name must ≥2-match the lead, else the VAT
 *     belongs to a different entity (franchisor/accountant) and the data is refused.
 *     (Openapi's by-VAT record is the official one; this catches a footer-VAT that
 *     pointed at the wrong company before the call's data is trusted.)
 *   - LEDGER — records the paid cost so the ceiling is observable.
 *   - MEMO — one call per VAT per process (don't pay twice for one company).
 *
 * What the ACTIVATION LAYER adds on top (later — docs/openapi_layer_rules.md):
 *   - "only TOP companies" eligibility predicate,
 *   - "on REQUEST only" (never an automatic/batch escalation),
 *   - the per-request / session € ceiling and operator confirmation.
 * This function is plumbing + the always-on safety rules; the activation layer is policy.
 *
 * SHAPE STATUS: the firmographic field paths come from OpenapiClient.mapAdvanced which
 * is PENDING verification against the first real response. Confirm + golden before any
 * production use.
 */

export interface OpenapiEnrichResult {
  ok: boolean;
  company?: OpenapiCompany;
  reason?: 'disabled' | 'bad_vat' | 'no_data' | 'entity_mismatch' | 'error';
  costEur: number;
}

const COST_ADVANCED_EUR = 0.1; // IT-advanced base price; best-price ~0.028 on a subscription

const memo = new Map<string, OpenapiEnrichResult>();

/**
 * Fetch advanced firmographics for ONE company by VAT, gated + entity-verified.
 * `leadCompanyName` is required for the entity-guard. Pass a `ledger` to record cost.
 * Never throws — failures degrade to `{ ok:false, reason:'error' }`.
 */
export async function enrichByVat(
  vat: string | undefined,
  leadCompanyName: string | undefined,
  opts: { ledger?: CostLedger; meta?: Record<string, string | number | boolean> } = {},
): Promise<OpenapiEnrichResult> {
  const client = new OpenapiClient();
  if (!client.available()) return { ok: false, reason: 'disabled', costEur: 0 };
  if (!vat) return { ok: false, reason: 'bad_vat', costEur: 0 };

  const cached = memo.get(vat);
  if (cached) return cached;

  let result: OpenapiEnrichResult;
  try {
    const company = await client.advancedByVat(vat);
    if (!company) {
      result = { ok: false, reason: 'bad_vat', costEur: 0 }; // checksum-failed → no call billed
    } else {
      // a real call was made → bill it, even on entity_mismatch (the lookup happened).
      opts.ledger?.record('openapi.it_advanced', 'enrich_field', COST_ADVANCED_EUR, true, { meta: opts.meta });
      if (isWrongEntity(company.companyName, leadCompanyName)) {
        result = { ok: false, reason: 'entity_mismatch', costEur: COST_ADVANCED_EUR };
      } else {
        result = { ok: true, company, costEur: COST_ADVANCED_EUR };
      }
    }
  } catch {
    result = { ok: false, reason: 'error', costEur: 0 };
  }
  memo.set(vat, result);
  return result;
}

/** Test/maintenance hook — clear the per-process memo. */
export function _clearOpenapiMemo(): void {
  memo.clear();
}
