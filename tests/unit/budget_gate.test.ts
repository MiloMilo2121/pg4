import { describe, it, expect } from 'vitest';
import { tierCapForLead, createRun, createPerLeadContext } from '../../src/runtime/run_context';

describe('tierCapForLead — per-lead budget gate', () => {
  it('returns the requested default when costEur < ceiling', () => {
    const run = createRun();
    const lead = createPerLeadContext(run);
    lead.costCeilingEur = 0.10;
    lead.costEur = 0.02;
    expect(tierCapForLead(lead, 4)).toBe(4);
    expect(lead.budgetExhausted).toBeFalsy();
  });

  it('caps to tier 1 (free SERP only) when costEur >= ceiling', () => {
    const run = createRun();
    const lead = createPerLeadContext(run);
    lead.costCeilingEur = 0.10;
    lead.costEur = 0.10;
    expect(tierCapForLead(lead, 4)).toBe(1);
    expect(lead.budgetExhausted).toBe(true);
  });

  it('idempotently flips budgetExhausted on subsequent calls', () => {
    const run = createRun();
    const lead = createPerLeadContext(run);
    lead.costCeilingEur = 0.05;
    lead.costEur = 0.05;
    tierCapForLead(lead);
    tierCapForLead(lead);
    expect(lead.budgetExhausted).toBe(true);
  });
});
