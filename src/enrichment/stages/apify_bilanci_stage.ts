import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage, StageRunOptions } from '../../types/enrichment';
import type { StageOutcome } from '../../types/output';
import type { ProviderRouter } from '../../providers/provider_router';
import { ApifyProvider } from '../../providers/apify/apify_provider';
import { companyNameMatches } from '../fields/field_registry';
import { validateItalianVatChecksum } from '../financial/vat';

/**
 * Apify balance-sheet register stage (jungle_synthesizer bilanci).
 * PAID (tier 2), default-OFF. Pulls by P.IVA what regdata's registro does NOT
 * expose: real **fatturato (revenue)** + PEC + dipendenti + capitale. Runs
 * BEFORE ApifyRegistroStage in the pipeline so registro only fires for what
 * bilanci left missing (utile / REA / decision-maker).
 *
 * Cost-safe: `router.invoke` (paid-gate / per-lead budget / run-ceiling /
 * breaker / ledger). Checksum-valid VAT only; double entity guard: the
 * record's own VAT must echo the query when present, and a clearly different
 * denominazione is refused. Never throws.
 */
export class ApifyBilanciStage implements Stage {
  readonly name = 'apify_bilanci';
  /**
   * The Apify run below is capped at 60 s; the stage deadline sits 30 s above
   * it so it only catches a hung connection and never abandons a run that is
   * already being paid for.
   */
  readonly timeoutMs = 90_000;

  constructor(private router: ProviderRouter, private provider: ApifyProvider = new ApifyProvider()) {}

  async run(ctx: PerLeadContext, lead: Lead, _normalized: NormalizedLead, opts: StageRunOptions = {}): Promise<StageOutcome> {
    const start = Date.now();
    const meta = this.provider.meta('bilanci');
    if (!meta.available()) return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'apify_bilanci_disabled' };

    const vat = (lead.vat_code_final as string | undefined)?.replace(/\D/g, '');
    if (!vat || vat.length !== 11 || !validateItalianVatChecksum(vat)) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'no_valid_vat' };
    }
    // Nothing to gain when the bilanci trio is already present.
    if (lead.revenue && lead.employees && lead.pec) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'already_complete' };
    }

    const name = (lead.company_name as string | undefined) ?? '';
    const remaining = (ctx.costCeilingEur ?? 0) - ctx.costEur;

    const rec = await this.router.invoke(
      meta,
      async () => {
        const r = await this.provider.bilanciLookup(vat, { timeoutMs: 60_000 });
        return r ? { ok: true, value: r } : null;
      },
      {
        paidEnabled: ctx.paidEnabled === true,
        remainingLeadBudgetEur: remaining,
        runCostCeilingEur: ctx.runCostCeilingEur,
        meta: { lead_id: ctx.leadId, run_id: ctx.runId ?? '', stage: this.name },
        signal: opts.signal,
      },
    );

    if (!rec) return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, detail: 'no_bilanci_match_or_gated' };
    // Entity guards — the record's own VAT must echo the query; a clearly
    // different denominazione means the register matched the wrong company.
    if (rec.vat && rec.vat !== vat) {
      return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, provider: meta.id, detail: `bilanci_vat_mismatch:${rec.vat}` };
    }
    if (rec.name && name && !companyNameMatches(rec.name, name)) {
      return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, provider: meta.id, detail: `bilanci_entity_mismatch:${rec.name}` };
    }

    const filled: string[] = [];
    const fill = (k: keyof Lead, v: string | undefined): void => {
      if (v && (lead[k] === undefined || lead[k] === null || lead[k] === '')) {
        (lead as Record<string, unknown>)[k as string] = v;
        filled.push(k as string);
      }
    };
    fill('revenue', rec.revenue);
    fill('revenue_year', rec.revenue_year);
    fill('employees', rec.employees);
    fill('share_capital', rec.share_capital);
    fill('legal_form', rec.legal_form);
    fill('ateco', rec.ateco);
    fill('pec', rec.pec);

    return {
      stage: this.name,
      status: filled.length > 0 ? 'success' : 'not_found',
      duration_ms: Date.now() - start,
      provider: meta.id,
      detail: filled.length > 0 ? `filled=${filled.join(',')}` : 'no_new_fields',
    };
  }
}
