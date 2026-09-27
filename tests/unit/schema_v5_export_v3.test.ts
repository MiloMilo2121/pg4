import { describe, it, expect } from 'vitest';
import { ENRICHED_CSV_COLUMNS, SCHEMA_VERSION } from '../../src/types/lead';
import type { Lead } from '../../src/types/lead';
import { V2_COLUMNS, CANDIDATE_COLUMNS, chooseColumns } from '../../tools/enrich3/export_v3';

describe('schema v5', () => {
  it('SCHEMA_VERSION is 5 and the V5 columns trail the enriched CSV in order', () => {
    expect(SCHEMA_VERSION).toBe(5);
    const tail = ENRICHED_CSV_COLUMNS.slice(-5);
    expect(tail).toEqual(['email_status', 'portal_source', 'portal_listings_count', 'portal_is_paid', 'portal_fiaip']);
  });

  it('append-only: the v4 columns still precede the v5 appendix', () => {
    const idxRea = ENRICHED_CSV_COLUMNS.indexOf('rea');
    const idxEmailStatus = ENRICHED_CSV_COLUMNS.indexOf('email_status');
    expect(idxRea).toBeGreaterThan(-1);
    expect(idxEmailStatus).toBeGreaterThan(idxRea);
  });
});

describe('export_v3 column projection', () => {
  it('the v2 header is verbatim: 21 columns, company_name first, _prov_query last', () => {
    expect(V2_COLUMNS).toHaveLength(21);
    expect(V2_COLUMNS[0]).toBe('company_name');
    expect(V2_COLUMNS[V2_COLUMNS.length - 1]).toBe('_prov_query');
    expect(V2_COLUMNS).toContain('lead_score');
  });

  it('chooseColumns appends only candidates whose fill-rate clears the threshold', () => {
    const leads: Lead[] = Array.from({ length: 100 }, (_, i) => ({
      company_name: `A${i}`,
      // email_status on 10% of rows; portal_fiaip on none.
      ...(i < 10 ? { email_status: 'deliverable' as const } : {}),
    }));
    const { columns, appended } = chooseColumns(leads, 0.005);
    expect(appended).toContain('email_status');
    expect(appended).not.toContain('portal_fiaip');
    expect(columns.slice(0, V2_COLUMNS.length)).toEqual([...V2_COLUMNS]);
    // appended columns keep the declared CANDIDATE order
    const order = appended.map((c) => CANDIDATE_COLUMNS.indexOf(c as (typeof CANDIDATE_COLUMNS)[number]));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('an all-empty state appends nothing', () => {
    const leads: Lead[] = [{ company_name: 'A' }];
    const { columns, appended } = chooseColumns(leads, 0.005);
    expect(appended).toHaveLength(0);
    expect(columns).toEqual([...V2_COLUMNS]);
  });
});
