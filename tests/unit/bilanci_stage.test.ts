import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApifyBilanciStage } from '../../src/enrichment/stages/apify_bilanci_stage';
import { ApifyProvider } from '../../src/providers/apify/apify_provider';
import { resetEnvCache } from '../../src/config/env';
import type { ProviderRouter } from '../../src/providers/provider_router';
import type { PerLeadContext } from '../../src/types/enrichment';
import type { Lead } from '../../src/types/lead';
import type { NormalizedLead } from '../../src/types/discovery';

const fakeRouter = {
  invoke: async (meta: { available: () => boolean }, call: () => Promise<{ ok: boolean; value: unknown } | null>) => {
    if (!meta.available()) return null;
    const r = await call();
    return r && r.ok ? r.value : null;
  },
} as unknown as ProviderRouter;

const ctxOf = (): PerLeadContext =>
  ({ leadId: 'L1', runId: 'R1', costEur: 0, costCeilingEur: 0.1, runCostCeilingEur: 1, paidEnabled: true, providersUsed: new Set() } as unknown as PerLeadContext);

const NORM = {} as NormalizedLead;
const VAT = '12345678903'; // checksum-valid

function enableApify(): void {
  process.env.APIFY_ENABLED = 'true';
  process.env.APIFY_API_KEY = 'tok';
  process.env.APIFY_BILANCI_ENABLED = 'true';
  resetEnvCache();
}
function clearEnv(): void {
  for (const k of ['APIFY_ENABLED', 'APIFY_API_KEY', 'APIFY_BILANCI_ENABLED']) delete process.env[k];
  resetEnvCache();
}
beforeEach(clearEnv);
afterEach(clearEnv);

function providerReturning(item: unknown): ApifyProvider {
  return new ApifyProvider(async () => ({ status: 200, json: item ? [item] : [] }));
}

describe('ApifyBilanciStage', () => {
  it('skips cleanly when disabled', async () => {
    const stage = new ApifyBilanciStage(fakeRouter, providerReturning(null));
    const out = await stage.run(ctxOf(), { company_name: 'Acme', vat_code_final: VAT } as Lead, NORM);
    expect(out.status).toBe('skipped');
    expect(out.detail).toBe('apify_bilanci_disabled');
  });

  it('skips without a checksum-valid VAT', async () => {
    enableApify();
    const stage = new ApifyBilanciStage(fakeRouter, providerReturning(null));
    const out = await stage.run(ctxOf(), { company_name: 'Acme', vat_code_final: '12345678900' } as Lead, NORM);
    expect(out.status).toBe('skipped');
    expect(out.detail).toBe('no_valid_vat');
  });

  it('fills revenue/pec/employees/capital (fatturato, NOT utile)', async () => {
    enableApify();
    const stage = new ApifyBilanciStage(
      fakeRouter,
      providerReturning({
        partitaIva: VAT,
        denominazione: 'Immobiliare Acme SRL',
        fatturato: '1200000',
        fatturatoAnno: '2024',
        dipendenti: '5',
        pec: 'acme@pec.it',
        capitaleSociale: '10000',
        formaGiuridica: 'SRL',
      }),
    );
    const lead = { company_name: 'Immobiliare Acme', vat_code_final: VAT } as Lead;
    const out = await stage.run(ctxOf(), lead, NORM);
    expect(out.status).toBe('success');
    expect(lead.revenue).toBe('1200000');
    expect(lead.revenue_year).toBe('2024');
    expect(lead.employees).toBe('5');
    expect(lead.pec).toBe('acme@pec.it');
    expect(lead.share_capital).toBe('10000');
    expect(lead.net_profit).toBeUndefined(); // bilanci never writes utile
  });

  it('refuses a record whose VAT does not echo the query', async () => {
    enableApify();
    const stage = new ApifyBilanciStage(fakeRouter, providerReturning({ partitaIva: '00000000000', denominazione: 'Immobiliare Acme', fatturato: '1' }));
    const lead = { company_name: 'Immobiliare Acme', vat_code_final: VAT } as Lead;
    const out = await stage.run(ctxOf(), lead, NORM);
    expect(out.status).toBe('not_found');
    expect(out.detail).toContain('bilanci_vat_mismatch');
    expect(lead.revenue).toBeUndefined();
  });

  it('refuses a clearly different denominazione (entity guard)', async () => {
    enableApify();
    const stage = new ApifyBilanciStage(fakeRouter, providerReturning({ partitaIva: VAT, denominazione: 'Pizzeria Da Mario SNC', fatturato: '1' }));
    const lead = { company_name: 'Immobiliare Acme', vat_code_final: VAT } as Lead;
    const out = await stage.run(ctxOf(), lead, NORM);
    expect(out.status).toBe('not_found');
    expect(out.detail).toContain('bilanci_entity_mismatch');
  });

  it('fill-only-empty: an existing revenue survives', async () => {
    enableApify();
    const stage = new ApifyBilanciStage(fakeRouter, providerReturning({ partitaIva: VAT, denominazione: 'Acme', fatturato: '999', dipendenti: '3' }));
    const lead = { company_name: 'Acme', vat_code_final: VAT, revenue: '555' } as Lead;
    await stage.run(ctxOf(), lead, NORM);
    expect(lead.revenue).toBe('555');
    expect(lead.employees).toBe('3');
  });
});
