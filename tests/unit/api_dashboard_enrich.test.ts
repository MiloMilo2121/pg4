import fs from 'fs';
import os from 'os';
import path from 'path';
import type { MxRecord } from 'dns';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../../src/types/lead';
import type { EnrichableField } from '../../src/types/api';
import type { EnrichmentFieldDescriptor, EnrichmentStep } from '../../src/enrichment/fields/field_types';
import type { SmtpDialer, SmtpReply } from '../../src/enrichment/email/mx_smtp_verifier';
import { emailInferenceStep } from '../../src/enrichment/email/email_inference_step';
import { runFieldDescriptor, type RunFieldOptions } from '../../src/enrichment/fields/run_field_cascade';
import { SuppressionList } from '../../src/compliance/suppression';
import { enrichCompanyFields, type EnrichCell } from '../../src/server/dashboard_enrich';

const RANDOM = 'nx-fixed';
const MX: MxRecord[] = [{ exchange: 'mx.rossi.it', priority: 10 }];

/** An SMTP server that accepts info@ and rejects every other address. */
const infoDeliverable: SmtpDialer = async () => ({
  command: async (line: string): Promise<SmtpReply> => {
    const code = line.includes(RANDOM) ? 550 : line.startsWith('RCPT TO:<info@') ? 250 : line.startsWith('RCPT TO:') ? 550 : 250;
    return { code, lines: [`${code} ok`] };
  },
  close: async () => {},
});

function suppressionFile(rows: string[]): SuppressionList {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-dash-supp-'));
  const file = path.join(dir, 'suppression.csv');
  fs.writeFileSync(file, ['phone,vat,email,reason,date', ...rows].join('\n'), 'utf8');
  return SuppressionList.fromFile(file);
}

const row = (over: Partial<Lead> = {}): Record<string, unknown> => ({
  company_name: 'Immobiliare Rossi',
  official_website: 'https://www.rossi.it',
  phone: '0491234567',
  ...over,
});

/** Runs the dashboard path with a cascade whose email step is a real inference step on fakes. */
async function runDashboard(rowIn: Record<string, unknown>, suppression: SuppressionList, cascadeStep: EnrichmentStep, field: EnrichableField = 'email') {
  const cells: Record<string, EnrichCell> = {};
  const patches: Array<Record<string, unknown>> = [];
  const fetched: string[] = [];
  const cascadeOpts: RunFieldOptions[] = [];
  let cost = 0;
  const descriptor: EnrichmentFieldDescriptor = { field, target: 'email_inferred', cascade: [cascadeStep], ceilingEur: 1, stopConfidence: 0.75 };
  await enrichCompanyFields(rowIn, [field], {
    fetchHtml: async (url) => {
      fetched.push(url);
      return undefined;
    },
    suppression,
    setCell: (f, c) => (cells[f] = c),
    patch: (p) => patches.push(p),
    addCost: (eur) => (cost += eur),
    cascade: (lead, _f, opts) => {
      cascadeOpts.push(opts);
      return runFieldDescriptor(lead, descriptor, opts);
    },
  });
  return { cells, patches, fetched, cascadeOpts, cost };
}

describe('dashboard enrich — suppression', () => {
  const inference = () =>
    emailInferenceStep({ enabled: true, resolveMx: async () => MX, randomLocalPart: () => RANDOM, dialer: infoDeliverable });

  it('fills an inferred email for a lead that is not suppressed (control)', async () => {
    const r = await runDashboard(row(), suppressionFile([]), inference());
    expect(r.cells.email).toMatchObject({ status: 'filled', value: 'info@rossi.it' });
    expect(r.patches).toEqual([{ email_inferred: 'info@rossi.it' }]);
  });

  it('never infers a suppressed email address', async () => {
    const r = await runDashboard(row(), suppressionFile([',,info@rossi.it,gdpr_objection,2026-09-01']), inference());
    expect(r.cells.email.status).toBe('not_found');
    expect(r.patches).toEqual([]);
    expect(r.cascadeOpts[0].isSuppressedEmail?.('INFO@rossi.it')).toBe(true);
  });

  it('never writes a suppressed address found on the website, like the CLI finalize', async () => {
    const fromBody: EnrichmentStep = { id: 'email.body_same_domain', tier: 0, costEur: 0, enabled: true, run: () => ({ value: 'Info@Rossi.it', confidence: 0.8, source: 'website_body', costEur: 0 }) };
    const r = await runDashboard(row(), suppressionFile([',,info@rossi.it,gdpr_objection,2026-09-01']), fromBody);
    expect(r.cells.email.status).toBe('not_found');
    expect(r.patches).toEqual([]);
  });

  it('drops a suppressed lead before any fetch or provider call, like the CLI', async () => {
    const r = await runDashboard(row(), suppressionFile(['+39 049 1234567,,,operator_request,2026-09-01']), inference());
    expect(r.fetched).toEqual([]);
    expect(r.cascadeOpts).toEqual([]);
    expect(r.cells.email).toMatchObject({ status: 'failed', value: expect.stringContaining('suppress') });
    expect(r.patches).toEqual([]);
  });
});

describe('dashboard enrich — paid gate and cost', () => {
  it('never runs a paid step: the dashboard has no ledger or ceiling to bound it', async () => {
    let ran = false;
    const paid: EnrichmentStep = {
      id: 'email.paid_fake',
      tier: 2,
      costEur: 0.04,
      enabled: true,
      run: () => {
        ran = true;
        return { value: 'paid@rossi.it', confidence: 0.9, source: 'paid', costEur: 0.04 };
      },
    };
    const r = await runDashboard(row(), suppressionFile([]), paid);
    expect(ran).toBe(false);
    expect(r.cascadeOpts[0].paidEnabled).toBe(false);
    expect(r.cells.email.status).toBe('not_found');
    expect(r.cost).toBe(0);
  });

  it('reports the cost the cascade actually recorded', async () => {
    const free: EnrichmentStep = { id: 'email.free', tier: 0, costEur: 0, enabled: true, run: () => ({ value: 'a@rossi.it', confidence: 0.9, source: 'body', costEur: 0 }) };
    const r = await runDashboard(row(), suppressionFile([]), free);
    expect(r.cells.email.status).toBe('filled');
    expect(r.cost).toBe(0);
  });

  it('marks an unknown field not_found without calling the cascade', async () => {
    const r = await runDashboard(row(), suppressionFile([]), emailInferenceStep({ enabled: false }), 'decision_maker' as EnrichableField);
    expect(r.cells.decision_maker.status).toBe('not_found');
    expect(r.cascadeOpts).toEqual([]);
  });
});
