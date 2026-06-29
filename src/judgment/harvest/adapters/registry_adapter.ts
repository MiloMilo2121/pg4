import type { Lead } from '../../../types/lead';
import type { Signal } from '../../../types/judgment';
import { OpenapiClient } from '../../../providers/openapi/openapi_client';
import { normalizeVatCode, validateItalianVatChecksum } from '../../../enrichment/financial/vat';
import { isWrongEntity } from '../../../enrichment/fields/field_registry';
import type { SourceAdapter, HarvestContext, HarvestResult } from '../source_harvest';
import { SOURCE_TTL_DAYS } from '../routing';

/**
 * Registry SourceAdapter (Axis-A spine) — wraps the existing OpenapiClient
 * (InfoCamere reseller). THIRD-PARTY source: feeds Axis A only. Disabled by
 * default (OPENAPI_ENABLED). MUST entity-guard every VAT-keyed datum with
 * `isWrongEntity` — the franchise-collision (€58M) defense. Returns ok:false
 * when unavailable or when the VAT belongs to a different legal entity.
 */
export class RegistrySourceAdapter implements SourceAdapter {
  readonly kind = 'registry' as const;
  readonly id = 'openapi';
  readonly tier = 1 as const;
  readonly costEur = 0;
  private client = new OpenapiClient();

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
    const rec = await this.client.advancedByVat(locator);
    if (!rec) return base;

    // ENTITY GUARD — the lead company name comes via ledgerMeta? No: the adapter
    // only has the locator. The collector passes the lead; here we read it from
    // ctx.ledgerMeta.company_name if present (set by the collector). If we cannot
    // verify the name, we DO NOT attach firmographics (fail safe).
    const leadName = typeof ctx.ledgerMeta?.company_name === 'string' ? (ctx.ledgerMeta.company_name as string) : undefined;
    if (isWrongEntity(rec.companyName, leadName)) {
      return { ...base, ok: true, raw: rec, attributes: {}, signals: [], };
    }

    const attributes: Record<string, string> = {};
    if (rec.vatCode) attributes.vat = rec.vatCode;
    if (rec.pec) attributes.pec = rec.pec;
    if (rec.revenue !== undefined) attributes.revenue = String(rec.revenue);
    if (rec.employees) attributes.employees = rec.employees;
    if (rec.legalRep) attributes.decision_maker = rec.legalRep;

    const signals: Signal[] = [];
    const evi = (excerpt: string, confidence = 0.9) => [{ source: 'registry:openapi', excerpt, observedAt: iso, confidence }];
    // §2.6 validation/traction — size proxies.
    if (rec.employees) signals.push({ axis: 'A', key: '2.6', state: 'confirmed_present', value: rec.employees, evidence: evi(`dipendenti: ${rec.employees}`) });
    if (rec.revenue !== undefined) signals.push({ axis: 'A', key: '2.6', state: 'confirmed_present', value: rec.revenue, evidence: evi(`fatturato: ${rec.revenue}`) });
    // activityStatus → distress signal feeds disqualifiers; here record as A-context.
    if (rec.activityStatus) signals.push({ axis: 'A', key: '2.6', state: 'confirmed_present', value: rec.activityStatus, evidence: evi(`stato attività: ${rec.activityStatus}`), notes: 'activity status (feeds §4.5 distress check)' });

    return { source: this.kind, sourceId: this.id, locator, fetchedAt: iso, ok: true, attributes, signals, raw: rec };
  }
}
