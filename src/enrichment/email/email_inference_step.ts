import type { EnrichmentStep, FieldStepContext, StepResult } from '../fields/field_types';
import { registrableDomain } from '../../util/domain';
import { generateCandidates } from './pattern_inference';
import { verifyEmails, type VerifyOptions } from './mx_smtp_verifier';

/**
 * The `email` field's inference step — bridges pattern inference + the MX/SMTP
 * handshake into one `EnrichmentStep` for the field cascade. Replaces the old
 * `disabled('email.pattern_guess')` placeholder, supplying the "real verifier"
 * the registry comment asked for.
 *
 * PRECISION-FIRST: `email_inferred` is filled ONLY with an address the verifier
 * confirmed `deliverable` on a NON-catch-all domain. Every other verdict
 * (catch_all / unknown / mx_only / undeliverable) returns no value but is
 * recorded in the per-step trace with its class, so the dashboard can show "we
 * tried, here's why we didn't assert one". €0 (DNS + SMTP are free).
 *
 * GDPR: an email is personal data. The step is gated OFF by default
 * (EMAIL_INFERENCE_MX_ENABLED) and refuses to synthesise a suppressed address
 * (`isSuppressed`) — a do-not-contact mailbox is never even guessed.
 */

export interface EmailInferenceOptions {
  enabled: boolean;
  /** Run the SMTP RCPT handshake. When false → MX-only, never fills. */
  smtpProbe?: boolean;
  heloName?: string;
  mailFrom?: string;
  maxProbes?: number;
  /** Returns true if an address is on the suppression list (never synthesised). */
  isSuppressed?: (email: string) => boolean;
  /** Test injection seams (forwarded to the verifier). */
  resolveMx?: VerifyOptions['resolveMx'];
  dialer?: VerifyOptions['dialer'];
  randomLocalPart?: VerifyOptions['randomLocalPart'];
}

const SOURCE = 'email:inference_mx';

/** Confidence for a verified-deliverable address: high (we proved it accepts mail). */
function deliverableConfidence(prior: number): number {
  return Math.min(0.92, 0.8 + prior * 0.2);
}

export function emailInferenceStep(opts: EmailInferenceOptions): EnrichmentStep {
  return {
    id: 'email.inference_mx',
    tier: 1, // free-network (DNS + SMTP), €0
    costEur: 0,
    enabled: opts.enabled,
    run: async (ctx: FieldStepContext): Promise<StepResult> => {
      const site =
        (ctx.lead.official_website as string | undefined) ?? (ctx.lead.website as string | undefined);
      const domain = registrableDomain(site);
      if (!domain) return { confidence: 0, source: SOURCE, costEur: 0, skippedReason: 'no_input' };

      let candidates = generateCandidates({
        domain,
        companyName: ctx.lead.company_name,
        personName: ctx.lead.decision_maker_name as string | undefined,
      });
      const isSuppressed = ctx.isSuppressedEmail ?? opts.isSuppressed;
      if (isSuppressed) candidates = candidates.filter((c) => !isSuppressed(c.email));
      if (candidates.length === 0) return { confidence: 0, source: SOURCE, costEur: 0, skippedReason: 'no_value' };

      const verdict = await verifyEmails(
        domain,
        candidates.map((c) => c.email),
        {
          smtpProbe: opts.smtpProbe,
          heloName: opts.heloName,
          mailFrom: opts.mailFrom,
          maxProbes: opts.maxProbes,
          resolveMx: opts.resolveMx,
          dialer: opts.dialer,
          randomLocalPart: opts.randomLocalPart,
        }
      );

      const taggedSource = `${SOURCE}(${verdict.cls})`;
      if (verdict.cls === 'deliverable' && verdict.email) {
        const prior = candidates.find((c) => c.email === verdict.email)?.prior ?? 0.3;
        return { value: verdict.email, confidence: deliverableConfidence(prior), source: taggedSource, costEur: 0 };
      }
      // catch_all / unknown / mx_only / undeliverable → never assert.
      return { confidence: 0, source: taggedSource, costEur: 0, skippedReason: 'no_value' };
    },
  };
}
