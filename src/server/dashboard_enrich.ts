import type { Lead } from '../types/lead';
import type { EnrichableField } from '../types/api';
import type { SuppressionList } from '../compliance/suppression';
import { runFieldCascade } from '../enrichment/fields/run_field_cascade';
import type { FieldCascadeOutcome, RunFieldOptions } from '../enrichment/fields/run_field_cascade';
import { FIELD_BY_NAME } from '../enrichment/fields/field_registry';
import { deepExtractFromSite } from '../enrichment/extract/deep_pages';
import type { BodyExtraction } from '../enrichment/extract/extract_from_body';

/**
 * The dashboard's "Arricchisci" button for one company. It must honour the same
 * compliance and cost contract as `pnpm enrich`: a lead on the suppression list
 * is dropped before any fetch, a suppressed address is never inferred, and paid
 * steps stay off (this path has no run ledger or ceiling to bound them).
 */

/** Dashboard field → the cascade that fills it. */
export const FIELD_FILL_TARGETS: Record<string, EnrichableField> = {
  email: 'email',
  pec: 'pec',
  vat: 'vat',
  revenue: 'revenue',
  employees: 'employees',
  instagram: 'instagram',
  facebook: 'facebook',
  linkedin: 'linkedin',
};

export interface EnrichCell {
  status: 'queued' | 'running' | 'filled' | 'failed' | 'not_found';
  value?: string;
  source?: string;
  confidence?: number;
}

export interface DashboardEnrichDeps {
  fetchHtml: (url: string) => Promise<string | undefined>;
  suppression: SuppressionList;
  setCell: (field: string, cell: EnrichCell) => void;
  patch: (fields: Record<string, unknown>) => void;
  addCost: (eur: number) => void;
  cascade?: (lead: Lead, field: EnrichableField, opts: RunFieldOptions) => Promise<FieldCascadeOutcome>;
}

export async function enrichCompanyFields(row: Record<string, unknown> | undefined, fields: string[], deps: DashboardEnrichDeps): Promise<void> {
  const cascade = deps.cascade ?? runFieldCascade;
  if (row && deps.suppression.matches(row as Lead)) {
    for (const f of fields) deps.setCell(f, { status: 'failed', value: 'suppressed: on the do-not-contact list' });
    return;
  }
  for (const f of fields) deps.setCell(f, { status: 'running' });

  // Deepened free-gold extraction: fetch the firm's homepage AND a bounded set
  // of its own contact/about pages ONCE, merged. About half of Italian SMB
  // sites print the email only on /contatti; the extractor enforces same-domain
  // on every page, so deepening lifts fill rate without lowering precision.
  let extraction: BodyExtraction | undefined;
  if (row?.official_website) {
    extraction = (await deepExtractFromSite(String(row.official_website), deps.fetchHtml)).extraction;
  }

  const isSuppressedEmail = (email: string): boolean => deps.suppression.matchesEmail(email);
  for (const f of fields) {
    const field = FIELD_FILL_TARGETS[f];
    if (!field) {
      deps.setCell(f, { status: 'not_found' });
      continue;
    }
    try {
      const lead = { ...row } as Lead;
      const outcome = await cascade(lead, field, { extraction, paidEnabled: false, isSuppressedEmail });
      deps.addCost(outcome.costEur);
      // The CLI strips a suppressed address at finalize, whatever step found it
      // (the website body included); this path has no finalize, so it checks here.
      if (outcome.resolved && outcome.value && deps.suppression.matchesEmail(outcome.value)) {
        deps.setCell(f, { status: 'not_found', source: 'suppressed' });
      } else if (outcome.resolved && outcome.value) {
        const target = FIELD_BY_NAME.get(field)!.target as string;
        deps.patch({ [target]: outcome.value });
        deps.setCell(f, { status: 'filled', value: outcome.value, source: outcome.source, confidence: outcome.confidence });
      } else {
        deps.setCell(f, { status: 'not_found' });
      }
    } catch (err) {
      // A field that throws becomes a visible failed cell, never a silent hang.
      deps.setCell(f, { status: 'failed', value: (err as Error).message.slice(0, 80) });
    }
  }
}
