import { describe, it, expect } from 'vitest';
import { resolveMx, verifyEmails } from '../../src/enrichment/email/mx_smtp_verifier';

const ENABLED = process.env.RUN_SMOKE === '1' || process.env.RUN_SMOKE === 'true';
// The live SMTP RCPT probe needs outbound port 25 (blocked on most CI/ISP hosts),
// so it is gated behind a SECOND flag. Without it we only exercise MX resolution.
const PROBE = process.env.RUN_SMTP_PROBE === '1' || process.env.RUN_SMTP_PROBE === 'true';

describe.runIf(ENABLED)('smoke: email MX/SMTP', () => {
  it('resolves real MX records for a known mail domain', async () => {
    const mx = await resolveMx('gmail.com');
    expect(mx.length).toBeGreaterThan(0);
    expect(mx[0].exchange).toMatch(/google|gmail/i);
    // sorted ascending by priority
    expect(mx[0].priority).toBeLessThanOrEqual(mx[mx.length - 1].priority);
  });

  it('degrades to mx_only when the SMTP probe is disabled', async () => {
    const r = await verifyEmails('gmail.com', ['info@gmail.com'], { smtpProbe: false });
    expect(r.cls).toBe('mx_only');
    expect(r.probedSmtp).toBe(false);
  });

  it.runIf(PROBE)('runs a live RCPT handshake without sending mail', async () => {
    // gmail is catch-all-ish / strict; we only assert the verifier returns a
    // valid class and never throws, not a specific verdict.
    const r = await verifyEmails('gmail.com', ['info@gmail.com'], { smtpProbe: true, timeoutMs: 10000 });
    expect(['deliverable', 'undeliverable', 'catch_all', 'unknown']).toContain(r.cls);
  });
});

describe.skipIf(ENABLED)('smoke: email MX/SMTP (skipped — RUN_SMOKE not set)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
});
