import * as dns from 'dns';
import * as net from 'net';
import { BlockedDestinationError, guardedLookup, isNonPublicAddress } from '../../providers/http/ssrf_guard';

/**
 * MX + SMTP-RCPT email verifier — the handshake that makes inference safe.
 *
 * Flow (Marco's "poi handshake mx"): resolve the domain's MX, open an SMTP
 * session to the lowest-priority MX, and probe candidate addresses with
 * `RCPT TO` only — HELO / MAIL FROM / RCPT TO, then QUIT. **We never send `DATA`,
 * so no mail is ever delivered.** A `250` on RCPT means the server would accept
 * mail for that mailbox.
 *
 * Honesty guards baked in:
 *  - CATCH-ALL: many domains accept every local-part. We probe a random
 *    non-existent address FIRST; if it is accepted, the domain is catch-all and
 *    a `250` on a real candidate proves nothing → class `catch_all`, no fill.
 *  - PORT 25 BLOCKED (the #1 real-world failure — most ISPs/clouds block
 *    outbound 25): the connection fails → class `unknown`, never `undeliverable`,
 *    never a fill. The caller degrades to MX-only and asserts nothing.
 *  - GREYLISTING (4xx): transient → class `unknown`, not a negative.
 *
 * Pure modulo DNS+socket: both `resolveMx` and the SMTP `dialer` are injectable,
 * so the unit tests run fully offline with a scripted transport.
 */

type MxClass = 'deliverable' | 'undeliverable' | 'catch_all' | 'mx_only' | 'unknown';

export interface MxVerifyResult {
  /** Verdict for the candidate set. */
  cls: MxClass;
  /** The deliverable address, only when cls === 'deliverable'. */
  email?: string;
  /** The MX host probed (lowest priority). */
  mxHost?: string;
  catchAll: boolean;
  /** Whether an SMTP RCPT probe actually ran (false when MX-only / no MX). */
  probedSmtp: boolean;
  /** Short machine reason for the trace (no_mx / probe_disabled / smtp_unreachable / greylist / …). */
  note?: string;
}

export interface SmtpReply {
  code: number;
  lines: string[];
}

interface SmtpSession {
  /** Send one SMTP command line and await its (possibly multiline) reply. */
  command(line: string): Promise<SmtpReply>;
  close(): Promise<void>;
}

/** Connect to an MX host, consume the 220 greeting, and return a session. */
export type SmtpDialer = (host: string, opts: { port: number; timeoutMs: number }) => Promise<SmtpSession>;

export interface VerifyOptions {
  /** Run the RCPT probe. When false → MX-only (class `mx_only`). Default true. */
  smtpProbe?: boolean;
  heloName?: string;
  mailFrom?: string;
  maxProbes?: number;
  timeoutMs?: number;
  resolveMx?: (domain: string) => Promise<dns.MxRecord[]>;
  dialer?: SmtpDialer;
  /** Random local-part for catch-all detection (injected in tests). */
  randomLocalPart?: () => string;
}

function isPositive(code: number): boolean {
  return code === 250 || code === 251;
}
function isTransient(code: number): boolean {
  return code >= 400 && code < 500;
}

/** Resolve MX records sorted by ascending priority (best first). Empty on failure. */
export async function resolveMx(domain: string, resolver?: (d: string) => Promise<dns.MxRecord[]>): Promise<dns.MxRecord[]> {
  const fn = resolver ?? dns.promises.resolveMx;
  try {
    const records = await fn(domain);
    return [...records].sort((a, b) => a.priority - b.priority);
  } catch {
    return [];
  }
}

/**
 * Verify a ranked candidate list against one domain. Resolves MX once, detects
 * catch-all, then probes candidates highest-first, stopping at the first
 * deliverable. Never throws — every failure maps to a class.
 */
export async function verifyEmails(domain: string, candidates: string[], opts: VerifyOptions = {}): Promise<MxVerifyResult> {
  const smtpProbe = opts.smtpProbe !== false;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxProbes = opts.maxProbes ?? 3;
  const heloName = opts.heloName ?? 'verifier.local';
  const mailFrom = opts.mailFrom ?? 'verify@verifier.local';

  const mx = await resolveMx(domain, opts.resolveMx);
  if (mx.length === 0) {
    return { cls: 'undeliverable', catchAll: false, probedSmtp: false, note: 'no_mx' };
  }
  const mxHost = mx[0].exchange;

  if (!smtpProbe) {
    return { cls: 'mx_only', mxHost, catchAll: false, probedSmtp: false, note: 'probe_disabled' };
  }

  const dialer = opts.dialer ?? defaultDialer;
  let session: SmtpSession;
  try {
    session = await dialer(mxHost, { port: 25, timeoutMs });
  } catch {
    // Port 25 blocked / host unreachable / timeout — the common case. Degrade.
    return { cls: 'unknown', mxHost, catchAll: false, probedSmtp: false, note: 'smtp_unreachable' };
  }

  try {
    const ehlo = await session.command(`EHLO ${heloName}`);
    if (!isPositive(ehlo.code)) {
      // Some servers want HELO; try once before giving up.
      const helo = await session.command(`HELO ${heloName}`);
      if (!isPositive(helo.code)) return { cls: 'unknown', mxHost, catchAll: false, probedSmtp: true, note: `helo_${helo.code}` };
    }
    const mailRes = await session.command(`MAIL FROM:<${mailFrom}>`);
    if (!isPositive(mailRes.code)) {
      return { cls: 'unknown', mxHost, catchAll: false, probedSmtp: true, note: `mailfrom_${mailRes.code}` };
    }

    // Catch-all probe first: a random local-part that should not exist.
    const rand = (opts.randomLocalPart ?? defaultRandomLocalPart)();
    const catchProbe = await session.command(`RCPT TO:<${rand}@${domain}>`);
    if (isPositive(catchProbe.code)) {
      return { cls: 'catch_all', mxHost, catchAll: true, probedSmtp: true, note: 'accepts_any' };
    }
    if (isTransient(catchProbe.code)) {
      return { cls: 'unknown', mxHost, catchAll: false, probedSmtp: true, note: 'greylist' };
    }

    // Probe real candidates, best-first, bounded.
    let sawTransient = false;
    for (const email of candidates.slice(0, maxProbes)) {
      await session.command('RSET');
      await session.command(`MAIL FROM:<${mailFrom}>`);
      const rcpt = await session.command(`RCPT TO:<${email}>`);
      if (isPositive(rcpt.code)) {
        return { cls: 'deliverable', email, mxHost, catchAll: false, probedSmtp: true, note: `rcpt_${rcpt.code}` };
      }
      if (isTransient(rcpt.code)) sawTransient = true;
    }
    return sawTransient
      ? { cls: 'unknown', mxHost, catchAll: false, probedSmtp: true, note: 'greylist' }
      : { cls: 'undeliverable', mxHost, catchAll: false, probedSmtp: true, note: 'rejected' };
  } catch {
    return { cls: 'unknown', mxHost, catchAll: false, probedSmtp: true, note: 'smtp_error' };
  } finally {
    try {
      await session.close();
    } catch {
      /* ignore close errors */
    }
  }
}

function defaultRandomLocalPart(): string {
  // Unlikely-to-exist local part for catch-all detection. Math.random is fine in
  // normal runtime code (only Workflow scripts forbid it); tests inject a fixed one.
  return `nx-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Real SMTP dialer over a TCP socket. Connects, consumes the 220 greeting, and
 * exposes a line-oriented command/reply transport. Handles multiline replies
 * (`250-foo` … `250 bar`) and enforces an idle timeout on every step.
 */
export const defaultDialer: SmtpDialer = (host, { port, timeoutMs }) =>
  new Promise<SmtpSession>((resolve, reject) => {
    // MX hosts come from DNS of scraped domains: never dial a non-public
    // address (IP literals checked here, hostnames at lookup time).
    if (net.isIP(host) && isNonPublicAddress(host)) {
      reject(new BlockedDestinationError(host, host));
      return;
    }
    const socket = net.connect({ host, port, lookup: guardedLookup() });
    socket.setTimeout(timeoutMs);
    socket.setEncoding('utf8');

    let buffer = '';
    let pending: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | null = null;

    const tryFlush = (): void => {
      // A complete reply ends with a line "NNN <text>" (space after the code).
      const lines = buffer.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = /^(\d{3}) /.exec(lines[i]);
        if (m) {
          const replyLines = lines.slice(0, i + 1);
          buffer = lines.slice(i + 1).join('\n');
          const reply: SmtpReply = { code: Number(m[1]), lines: replyLines };
          if (pending) {
            const p = pending;
            pending = null;
            p.resolve(reply);
          }
          return;
        }
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      tryFlush();
    });
    socket.on('timeout', () => {
      socket.destroy();
      const err = new Error('smtp_timeout');
      if (pending) {
        pending.reject(err);
        pending = null;
      } else reject(err);
    });
    socket.on('error', (err) => {
      if (pending) {
        pending.reject(err);
        pending = null;
      } else reject(err);
    });

    let greeted = false;
    const waitReply = (): Promise<SmtpReply> =>
      new Promise<SmtpReply>((res, rej) => {
        pending = { resolve: res, reject: rej };
        tryFlush();
      });

    socket.on('connect', () => {
      // Consume the 220 greeting before resolving the session.
      waitReply()
        .then((greeting) => {
          greeted = true;
          if (greeting.code !== 220) {
            socket.destroy();
            reject(new Error(`smtp_greeting_${greeting.code}`));
            return;
          }
          resolve({
            command: (line: string) => {
              socket.write(`${line}\r\n`);
              return waitReply();
            },
            close: () =>
              new Promise<void>((done) => {
                try {
                  socket.write('QUIT\r\n');
                } catch {
                  /* ignore */
                }
                socket.end();
                socket.destroy();
                done();
              }),
          });
        })
        .catch((e) => {
          socket.destroy();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });

    socket.on('close', () => {
      if (!greeted && pending) {
        pending.reject(new Error('smtp_closed'));
        pending = null;
      }
    });
  });
