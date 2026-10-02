import type { Lead } from '../../types/lead';
import type { NormalizedLead } from '../../types/discovery';
import type { PerLeadContext, Stage, StageRunOptions } from '../../types/enrichment';
import type { StageOutcome } from '../../types/output';
import type { ProviderRouter } from '../../providers/provider_router';
import { ApifyProvider } from '../../providers/apify/apify_provider';
import { companyNameMatches } from '../fields/field_registry';
import { validateItalianVatChecksum } from '../financial/vat';

/**
 * Apify Registro-Imprese enrichment stage. PAID (tier 2), default-OFF. Pulls
 * Italian business-register firmographics by P.IVA (regdata / ufficiocamerale.it):
 * legal form, ATECO, share capital, **net profit (utile)**, employees, PEC, REA.
 *
 * NOTE on `net_profit`: this is the UTILE (net profit), NOT fatturato (revenue) —
 * the register exposes utile, not turnover. Kept in its own field so it is never
 * confused with `revenue`.
 *
 * Cost-safe: goes through `router.invoke` (same paid-gate / per-lead budget /
 * run-ceiling / breaker / ledger). Runs ONLY on a checksum-valid VAT and is
 * entity-guarded by `companyNameMatches` (a register record with a different
 * denominazione is refused — never poison a lead with the wrong company's
 * financials). Never throws.
 */
export class ApifyRegistroStage implements Stage {
  readonly name = 'apify_registro';
  /**
   * The Apify run below is capped at 60 s; the stage deadline sits 30 s above
   * it so it only catches a hung connection and never abandons a run that is
   * already being paid for.
   */
  readonly timeoutMs = 90_000;

  constructor(private router: ProviderRouter, private provider: ApifyProvider = new ApifyProvider()) {}

  async run(ctx: PerLeadContext, lead: Lead, _normalized: NormalizedLead, opts: StageRunOptions = {}): Promise<StageOutcome> {
    const start = Date.now();
    const meta = this.provider.meta('registro');
    if (!meta.available()) return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'apify_registro_disabled' };

    const vat = (lead.vat_code_final as string | undefined)?.replace(/\D/g, '');
    if (!vat || vat.length !== 11 || !validateItalianVatChecksum(vat)) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'no_valid_vat' };
    }
    // Nothing to gain if the register firmographics are already present.
    if (lead.net_profit && lead.employees && lead.legal_form) {
      return { stage: this.name, status: 'skipped', duration_ms: 0, detail: 'already_complete' };
    }

    const name = (lead.company_name as string | undefined) ?? '';
    const remaining = (ctx.costCeilingEur ?? 0) - ctx.costEur;

    const rec = await this.router.invoke(
      meta,
      async () => {
        const r = await this.provider.registroLookup(vat, { timeoutMs: 60_000 });
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

    if (!rec) return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, detail: 'no_register_match_or_gated' };
    // Entity guard — a register record with a clearly different name is a wrong VAT.
    if (rec.name && name && !companyNameMatches(rec.name, name)) {
      return { stage: this.name, status: 'not_found', duration_ms: Date.now() - start, provider: meta.id, detail: `registro_entity_mismatch:${rec.name}` };
    }

    const filled: string[] = [];
    const fill = (k: keyof Lead, v: string | undefined): void => {
      if (v && (lead[k] === undefined || lead[k] === null || lead[k] === '')) {
        (lead as Record<string, unknown>)[k as string] = v;
        filled.push(k as string);
      }
    };
    fill('net_profit', rec.net_profit);
    fill('net_profit_year', rec.net_profit_year);
    fill('share_capital', rec.share_capital);
    fill('legal_form', rec.legal_form);
    fill('ateco', rec.ateco);
    fill('rea', rec.rea);
    fill('employees', rec.employees);
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
