import { describe, it, expect } from 'vitest';
import type { MxRecord } from 'dns';
import { verifyEmails, type SmtpDialer, type SmtpReply } from '../../src/enrichment/email/mx_smtp_verifier';

const MX: MxRecord[] = [
  { exchange: 'mx2.rossi.it', priority: 20 },
  { exchange: 'mx1.rossi.it', priority: 10 },
];
const resolveOk = async (): Promise<MxRecord[]> => MX;
const RANDOM = 'catchall-probe-fixed';

/** A scripted SMTP transport: `reply(line)` decides each command's code. */
function scriptedDialer(reply: (line: string) => number, opts: { failConnect?: boolean } = {}): SmtpDialer {
  return async () => {
    if (opts.failConnect) throw new Error('ECONNREFUSED');
    return {
      command: async (line: string): Promise<SmtpReply> => {
        const code = reply(line);
        return { code, lines: [`${code} ok`] };
      },
      close: async () => {},
    };
  };
}

describe('verifyEmails — MX + SMTP handshake', () => {
  it('returns undeliverable (no_mx) when the domain has no MX', async () => {
    const r = await verifyEmails('rossi.it', ['info@rossi.it'], { resolveMx: async () => [] });
    expect(r.cls).toBe('undeliverable');
    expect(r.note).toBe('no_mx');
    expect(r.probedSmtp).toBe(false);
  });

  it('returns mx_only when SMTP probing is disabled (port-25-safe mode)', async () => {
    const r = await verifyEmails('rossi.it', ['info@rossi.it'], { resolveMx: resolveOk, smtpProbe: false });
    expect(r.cls).toBe('mx_only');
    expect(r.mxHost).toBe('mx1.rossi.it'); // lowest priority chosen
    expect(r.probedSmtp).toBe(false);
  });

  it('returns unknown (smtp_unreachable) when port 25 is blocked', async () => {
    const r = await verifyEmails('rossi.it', ['info@rossi.it'], {
      resolveMx: resolveOk,
      dialer: scriptedDialer(() => 250, { failConnect: true }),
    });
    expect(r.cls).toBe('unknown');
    expect(r.note).toBe('smtp_unreachable');
  });

  it('returns deliverable for an accepted, non-catch-all candidate', async () => {
    const dialer = scriptedDialer((line) => {
      if (line.includes(RANDOM)) return 550; // catch-all probe rejected → not catch-all
      if (line.startsWith('RCPT TO:<info@')) return 250; // real candidate accepted
      if (line.startsWith('RCPT TO:')) return 550;
      return 250; // EHLO / MAIL FROM / RSET
    });
    const r = await verifyEmails('rossi.it', ['info@rossi.it', 'contatti@rossi.it'], {
      resolveMx: resolveOk,
      dialer,
      randomLocalPart: () => RANDOM,
    });
    expect(r.cls).toBe('deliverable');
    expect(r.email).toBe('info@rossi.it');
    expect(r.catchAll).toBe(false);
  });

  it('detects a catch-all domain and refuses to assert', async () => {
    const dialer = scriptedDialer(() => 250); // accepts EVERYTHING, including the random probe
    const r = await verifyEmails('rossi.it', ['info@rossi.it'], {
      resolveMx: resolveOk,
      dialer,
      randomLocalPart: () => RANDOM,
    });
    expect(r.cls).toBe('catch_all');
    expect(r.catchAll).toBe(true);
    expect(r.email).toBeUndefined();
  });

  it('returns undeliverable when every candidate is rejected (550)', async () => {
    const dialer = scriptedDialer((line) => (line.startsWith('RCPT TO:') ? 550 : 250));
    const r = await verifyEmails('rossi.it', ['info@rossi.it', 'contatti@rossi.it'], {
      resolveMx: resolveOk,
      dialer,
      randomLocalPart: () => RANDOM,
    });
    expect(r.cls).toBe('undeliverable');
  });

  it('returns unknown on greylisting (4xx) without asserting', async () => {
    const dialer = scriptedDialer((line) => (line.includes(RANDOM) ? 451 : 250));
    const r = await verifyEmails('rossi.it', ['info@rossi.it'], {
      resolveMx: resolveOk,
      dialer,
      randomLocalPart: () => RANDOM,
    });
    expect(r.cls).toBe('unknown');
    expect(r.note).toBe('greylist');
  });

  it('caps the number of RCPT probes per domain', async () => {
    const probed: string[] = [];
    const dialer = scriptedDialer((line) => {
      if (line.startsWith('RCPT TO:') && !line.includes(RANDOM)) probed.push(line);
      return line.startsWith('RCPT TO:') ? 550 : 250; // none deliverable
    });
    await verifyEmails('rossi.it', ['a@rossi.it', 'b@rossi.it', 'c@rossi.it', 'd@rossi.it', 'e@rossi.it'], {
      resolveMx: resolveOk,
      dialer,
      randomLocalPart: () => RANDOM,
      maxProbes: 2,
    });
    expect(probed.length).toBe(2);
  });
});
