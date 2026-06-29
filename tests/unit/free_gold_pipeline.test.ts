import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { runEnrichmentPipeline } from '../../src/enrichment/enrichment_pipeline';
import { ProviderRouter } from '../../src/providers/provider_router';
import { CostLedger } from '../../src/runtime/cost_ledger';
import { createPerLeadContext, createRun } from '../../src/runtime/run_context';
import type { Lead } from '../../src/types/lead';

/**
 * Phase 1 (free-gold) — pipeline-level proof: when a website-discovery stage
 * has stashed the firm's own page body on `perLead.verifiedBody`, the
 * pipeline mines it for email/social/VAT and adds ZERO cost.
 *
 * We pre-seed `verifiedBody` (the empty router + dead DNS guarantee no real
 * website match occurs, so nothing overwrites it) and assert both the
 * extraction AND `cost_eur === 0`.
 */
const deadDns = async (_host: string) => Promise.reject(new Error('ENOTFOUND'));
const FIX = path.join(__dirname, '..', 'fixtures', 'extract');
const load = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');

describe('free-gold pipeline integration (zero-cost)', () => {
  it('mines a verified body into email/PEC/phone with cost_eur unchanged at 0', async () => {
    const run = createRun();
    const router = new ProviderRouter([], [], [], new CostLedger());
    const perLead = createPerLeadContext(run);
    perLead.verifiedBody = load('it_site_pec_and_phone.html');

    const lead: Lead = {
      company_name: 'Neri Servizi Srl', city: 'Treviso', province: 'TV',
      address: 'Via Roma 1', official_website: 'https://neriservizi.it',
    };
    const result = await runEnrichmentPipeline({ run, perLead, router, lead, dnsResolver: deadDns });

    expect(result.lead.email_inferred).toBe('contatti@neriservizi.it');
    expect(result.lead.pec).toBe('neriservizi@pec.it');
    expect(result.stage_outcomes.free_gold?.status).toBe('success');
    // The whole point: extraction added zero network cost.
    expect(result.lead.cost_eur ?? 0).toBe(0);
    expect(result.cost_eur).toBe(0);
  });

  it('mines social profiles from a verified body at zero cost', async () => {
    const run = createRun();
    const router = new ProviderRouter([], [], [], new CostLedger());
    const perLead = createPerLeadContext(run);
    perLead.verifiedBody = load('it_site_footer_socials.html');

    const lead: Lead = {
      company_name: 'Agenzia Bianchi Case Srl', city: 'Verona', province: 'VR',
      address: 'Corso Italia 5', official_website: 'https://bianchicase.it',
    };
    const result = await runEnrichmentPipeline({ run, perLead, router, lead, dnsResolver: deadDns });

    expect(result.lead.instagram).toBe('https://instagram.com/agenziabianchi');
    expect(result.lead.facebook).toBe('https://facebook.com/agenziabianchicase');
    expect(result.lead.linkedin).toBe('https://linkedin.com/company/agenzia-bianchi');
    expect(result.cost_eur).toBe(0);
  });

  it('no verified body → no free_gold outcome, no crash', async () => {
    const run = createRun();
    const router = new ProviderRouter([], [], [], new CostLedger());
    const perLead = createPerLeadContext(run);
    // verifiedBody intentionally unset
    const lead: Lead = { company_name: 'X' };
    const result = await runEnrichmentPipeline({ run, perLead, router, lead, dnsResolver: deadDns });
    expect(result.stage_outcomes.free_gold).toBeUndefined();
    expect(result.lead.email_inferred).toBeUndefined();
  });
});
