import type { Lead } from '../../../types/lead';
import type { Signal } from '../../../types/judgment';
import type { CostedMeta } from '../../../types/providers';
import { OpenapiClient } from '../../../providers/openapi_it/openapi_client';
import type { OpenapiCompany } from '../../../providers/openapi_it/openapi_client';
import { CALL_COST_EUR } from '../../../providers/pricing';
import { normalizeVatCode, validateItalianVatChecksum } from '../../../enrichment/financial/vat';
import { isWrongEntity } from '../../../enrichment/fields/field_registry';
import type { SourceAdapter, HarvestContext, HarvestResult } from '../source_harvest';
import { SOURCE_TTL_DAYS } from '../source_ttl';

type RegistryClient = Pick<OpenapiClient, 'available' | 'advancedByVat'>;

/**
 * Registry SourceAdapter (Axis-A spine) — wraps the existing OpenapiClient
 * (InfoCamere reseller). THIRD-PARTY source: feeds Axis A only. Disabled by
 * default (OPENAPI_ENABLED).
 *
 * PAID: one /IT-advanced lookup per VAT. The call runs only through
 * `ctx.router.invoke`, so it is subject to the paid gate, the breaker and the
 * run/lead budgets, and its cost lands in the router's ledger. The harvest is
 * cached per VAT, so a VAT shared by several leads is paid once.
 *
 * ENTITY GUARD: every firmographic is VAT-keyed, and a footer VAT can belong to
 * a different legal entity (franchisor, accountant). `admit` refuses the data
 * unless the registered name verifiably matches the lead — the franchise-
 * collision (€58M) defense.
 */
export class RegistrySourceAdapter implements SourceAdapter {
  readonly kind = 'registry' as const;
  readonly id = 'openapi';
  readonly tier = 2 as const;
  readonly costEur = CALL_COST_EUR.openapi_advanced;
  private readonly client: RegistryClient;

  constructor(client: RegistryClient = new OpenapiClient()) {
    this.client = client;
  }

  available(): boolean {
    return this.client.available();
  }

  ttlDays(): number | null {
    return SOURCE_TTL_DAYS.registry; // null — firmographics don't change
  }

  locate(lead: Lead): string | undefined {
    const candidate = (lead.vat_code_final as string | undefined) ?? (lead.vat_code as string | undefined);
    const v = normalizeVatCode(candidate);
    return /^\d{11}$/.test(v) && validateItalianVatChecksum(v) ? v : undefined;
  }

  async harvest(locator: string, ctx: HarvestContext): Promise<HarvestResult> {
    const iso = new Date(ctx.now()).toISOString();
    const base: HarvestResult = { source: this.kind, sourceId: this.id, locator, fetchedAt: iso, ok: false, attributes: {}, signals: [] };
    if (!ctx.paidEnabled || !ctx.router) return base;
    const meta: CostedMeta = { id: this.id, family: 'official', tier: this.tier, costPerCallEur: this.costEur, available: () => this.client.available() };
    const rec = await ctx.router.invoke(
      meta,
      async () => {
        const r = await this.client.advancedByVat(locator);
        return r ? { ok: true, value: r } : null;
      },
      { ...ctx.route, paidEnabled: ctx.paidEnabled, meta: { ...ctx.ledgerMeta, stage: 'judgment_registry' } },
    );
    if (!rec) return base;

    const attributes: Record<string, string> = {};
    if (rec.vatCode) attributes.vat = rec.vatCode;
    if (rec.pec) attributes.pec = rec.pec;
    if (rec.revenue !== undefined) attributes.revenue = String(rec.revenue);
    if (rec.employees) attributes.employees = rec.employees;
    if (rec.legalRep) attributes.decision_maker = rec.legalRep;

    const signals: Signal[] = [];
    const evi = (excerpt: string, confidence = 0.9) => [{ source: 'registry:openapi', excerpt, observedAt: iso, confidence }];
    // Validation/traction — size proxies.
    if (rec.employees) signals.push({ axis: 'A', key: '2.6', state: 'confirmed_present', value: rec.employees, evidence: evi(`dipendenti: ${rec.employees}`) });
    if (rec.revenue !== undefined) signals.push({ axis: 'A', key: '2.6', state: 'confirmed_present', value: rec.revenue, evidence: evi(`fatturato: ${rec.revenue}`) });
    // activityStatus → distress signal feeds disqualifiers; here record as A-context.
    if (rec.activityStatus) signals.push({ axis: 'A', key: '2.6', state: 'confirmed_present', value: rec.activityStatus, evidence: evi(`stato attività: ${rec.activityStatus}`), notes: 'activity status (feeds §4.5 distress check)' });

    return { source: this.kind, sourceId: this.id, locator, fetchedAt: iso, ok: true, attributes, signals, raw: rec };
  }

  admit(result: HarvestResult, lead: Lead): HarvestResult {
    if (!result.ok) return result;
    const rec = result.raw as OpenapiCompany | undefined;
    if (!isWrongEntity(rec?.companyName, lead.company_name as string | undefined)) return result;
    // Unverified or foreign: the lookup stays paid and cached, but nothing of
    // that record reaches this lead.
    return { ...result, attributes: {}, signals: [], raw: undefined };
  }
}
