import { describe, it, expect } from 'vitest';
import type { MxRecord } from 'dns';
import type { Lead } from '../../src/types/lead';
import type { FieldStepContext, EnrichmentFieldDescriptor } from '../../src/enrichment/fields/field_types';
import { emailInferenceStep } from '../../src/enrichment/email/email_inference_step';
import { runFieldDescriptor } from '../../src/enrichment/fields/run_field_cascade';
import type { SmtpDialer, SmtpReply } from '../../src/enrichment/email/mx_smtp_verifier';

const MX: MxRecord[] = [{ exchange: 'mx.rossi.it', priority: 10 }];
const RANDOM = 'nx-fixed';
const resolveOk = async (): Promise<MxRecord[]> => MX;

function dialer(reply: (line: string) => number): SmtpDialer {
  return async () => ({
    command: async (line: string): Promise<SmtpReply> => ({ code: reply(line), lines: [`${reply(line)} ok`] }),
    close: async () => {},
  });
}

const leadOf = (over: Partial<Lead> = {}): Lead =>
  ({ company_name: 'Immobiliare Rossi', official_website: 'https://www.rossi.it', source: 'INPUT_CSV', ...over } as Lead);

const ctxOf = (lead: Lead, isSuppressedEmail?: (e: string) => boolean): FieldStepContext => ({
  lead,
  paidEnabled: false,
  isSuppressedEmail,
});

describe('emailInferenceStep', () => {
  it('fills a verified-deliverable address at fill-worthy confidence', async () => {
    const step = emailInferenceStep({
      enabled: true,
      resolveMx: resolveOk,
      randomLocalPart: () => RANDOM,
      dialer: dialer((line) => {
        if (line.includes(RANDOM)) return 550;
        if (line.startsWith('RCPT TO:<info@')) return 250;
        if (line.startsWith('RCPT TO:')) return 550;
        return 250;
      }),
    });
    const res = await step.run(ctxOf(leadOf()));
    expect(res.value).toBe('info@rossi.it');
    expect(res.confidence).toBeGreaterThanOrEqual(0.75);
    expect(res.source).toContain('deliverable');
  });

  it('asserts nothing on a catch-all domain', async () => {
    const step = emailInferenceStep({ enabled: true, resolveMx: resolveOk, randomLocalPart: () => RANDOM, dialer: dialer(() => 250) });
    const res = await step.run(ctxOf(leadOf()));
    expect(res.value).toBeUndefined();
    expect(res.source).toContain('catch_all');
  });

  it('asserts nothing (mx_only) when SMTP probing is off', async () => {
    const step = emailInferenceStep({ enabled: true, smtpProbe: false, resolveMx: resolveOk });
    const res = await step.run(ctxOf(leadOf()));
    expect(res.value).toBeUndefined();
    expect(res.source).toContain('mx_only');
  });

  it('skips when there is no verified domain', async () => {
    const step = emailInferenceStep({ enabled: true, resolveMx: resolveOk });
    const res = await step.run(ctxOf(leadOf({ official_website: undefined, website: undefined })));
    expect(res.skippedReason).toBe('no_input');
  });

  it('never synthesises a suppressed address', async () => {
    const probed: string[] = [];
    const step = emailInferenceStep({
      enabled: true,
      resolveMx: resolveOk,
      randomLocalPart: () => RANDOM,
      dialer: dialer((line) => {
        if (line.startsWith('RCPT TO:') && !line.includes(RANDOM)) probed.push(line);
        if (line.includes(RANDOM)) return 550;
        if (line.startsWith('RCPT TO:<info@')) return 250; // would be deliverable…
        if (line.startsWith('RCPT TO:')) return 550;
        return 250;
      }),
    });
    const res = await step.run(ctxOf(leadOf(), (e) => e === 'info@rossi.it'));
    // info@ was suppressed → never probed, never returned
    expect(probed.some((l) => l.includes('info@rossi.it'))).toBe(false);
    expect(res.value).toBeUndefined();
  });
});

describe('email inference via the field runner', () => {
  const descriptorWith = (step: ReturnType<typeof emailInferenceStep>): EnrichmentFieldDescriptor => ({
    field: 'email',
    target: 'email_inferred',
    cascade: [step],
    ceilingEur: 0,
    stopConfidence: 0.75,
  });

  it('fill-only-missing: never overwrites an existing email_inferred', async () => {
    const step = emailInferenceStep({
      enabled: true,
      resolveMx: resolveOk,
      randomLocalPart: () => RANDOM,
      dialer: dialer((line) => (line.includes(RANDOM) ? 550 : line.startsWith('RCPT TO:<info@') ? 250 : line.startsWith('RCPT TO:') ? 550 : 250)),
    });
    const lead = leadOf({ email_inferred: 'already@rossi.it' });
    await runFieldDescriptor(lead, descriptorWith(step));
    expect(lead.email_inferred).toBe('already@rossi.it'); // unchanged
  });

  it('writes email_inferred when empty and a deliverable address is found', async () => {
    const step = emailInferenceStep({
      enabled: true,
      resolveMx: resolveOk,
      randomLocalPart: () => RANDOM,
      dialer: dialer((line) => (line.includes(RANDOM) ? 550 : line.startsWith('RCPT TO:<info@') ? 250 : line.startsWith('RCPT TO:') ? 550 : 250)),
    });
    const lead = leadOf();
    const outcome = await runFieldDescriptor(lead, descriptorWith(step));
    expect(outcome.resolved).toBe(true);
    expect(lead.email_inferred).toBe('info@rossi.it');
  });
});
