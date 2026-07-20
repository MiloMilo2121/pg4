import { parseArgs, optString } from '../../cli/_args';
import type { Lead } from '../../types/lead';
import { ApifyProvider } from '../../providers/apify/apify_provider';
import { resolveMx } from '../../enrichment/email/mx_smtp_verifier';
import { loadState, saveState, buildE3Run, has, closeLedger, runIfMain } from './_shared';
import { logger } from '../../runtime/logger';

/**
 * ENRICH-3 R3 — email deliverability. Free shortcuts FIRST (nothing paid is
 * spent on what DNS already answers):
 *   - PEC domain (or email_type='pec') → status 'pec'
 *   - domain without MX → 'invalid'
 * The rest goes to the pluggable Apify verifier actor in chunks, through
 * `router.invoke` (reservation = chunk×€0.001 worst-case, real cost from the
 * result count). `invalid` NEVER deletes `email_inferred` — the consumer
 * filters on `email_status`; leads the pass didn't reach keep NO status
 * (absence = not-verified, an honest signal).
 *
 *   # probe (validates the chosen actor on 10 emails):
 *   APIFY_ENABLED=true APIFY_EMAIL_VERIFY_ENABLED=true APIFY_EMAIL_VERIFY_ACTOR_ID=<id> \
 *     pnpm tsx src/scripts/enrich3/email_verify.ts --state ... --probe
 *   # full:
 *   ... pnpm tsx src/scripts/enrich3/email_verify.ts --state output/enrich3/state3.jsonl \
 *     --out output/enrich3/state4 --run-cost-ceiling-eur 6
 */

export const PEC_DOMAINS =
  /@(?:[a-z0-9.-]+\.)?(pec\.it|legalmail\.it|pec\.aruba\.it|arubapec\.it|postecert\.it|pec\.cloud|mypec\.eu|pecimprese\.it|legpec\.it|sicurezzapostale\.it|pec\.libero\.it|pec\.buffetti\.it|postacert\.[a-z.]+|cert\.[a-z0-9.-]+)$/i;

/** Single place encoding the verifier actor's input shape (probe-validated). */
export function buildEmailVerifyInput(emails: string[]): Record<string, unknown> {
  return { emails };
}

function leadEmail(lead: Lead): string | undefined {
  const e = has(lead.email_inferred) ? lead.email_inferred : lead.email;
  return typeof e === 'string' && e.includes('@') ? e.trim().toLowerCase() : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const statePath = optString(args, 'state') ?? 'output/enrich3/state3.jsonl';
  const out = optString(args, 'out') ?? 'output/enrich3/state4';
  const probe = args.flags.probe === true;
  const chunkSize = Number(optString(args, 'chunk') ?? '500');
  const ceiling = Number(optString(args, 'run-cost-ceiling-eur') ?? (probe ? '0.2' : ''));
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error('--run-cost-ceiling-eur is required (hard cap for the pass)');

  const leads = await loadState(statePath);
  const statusByEmail = new Map<string, Lead['email_status']>();
  const emails = new Set<string>();
  for (const lead of leads) {
    const e = leadEmail(lead);
    if (e) emails.add(e);
  }

  // ---- free shortcuts ----
  const mxCache = new Map<string, boolean>();
  let pecCount = 0;
  let noMx = 0;
  const toVerify: string[] = [];
  for (const e of emails) {
    if (PEC_DOMAINS.test(e)) {
      statusByEmail.set(e, 'pec');
      pecCount += 1;
      continue;
    }
    const domain = e.split('@')[1];
    let hasMx = mxCache.get(domain);
    if (hasMx === undefined) {
      try {
        hasMx = (await resolveMx(domain)).length > 0;
      } catch {
        hasMx = true; // DNS hiccup must not brand an email invalid
      }
      mxCache.set(domain, hasMx);
    }
    if (!hasMx) {
      statusByEmail.set(e, 'invalid');
      noMx += 1;
      continue;
    }
    toVerify.push(e);
  }
  logger.info({ unique: emails.size, pec: pecCount, no_mx: noMx, to_verify: toVerify.length }, '[email_verify] free shortcuts done');

  // ---- paid verify via the pluggable actor ----
  const provider = new ApifyProvider();
  const unit = provider.meta('email_verify').costPerCallEur;
  const { run, router } = buildE3Run({
    ledgerPath: 'output/enrich3/email_verify/ledger.jsonl',
    paidEnabled: true,
    runCostCeilingEur: ceiling,
  });
  const batch = probe ? toVerify.slice(0, 10) : toVerify;
  let verified = 0;
  for (let i = 0; i < batch.length; i += chunkSize) {
    const chunk = batch.slice(i, i + chunkSize);
    const meta = { ...provider.meta('email_verify'), costPerCallEur: chunk.length * unit };
    const items = await router.invoke<unknown[]>(
      meta,
      async () => {
        const got = await provider.runActorAsync('email_verify', buildEmailVerifyInput(chunk), {
          maxItems: chunk.length,
          timeoutMs: 900_000,
        });
        return { ok: got.length > 0, value: got, cost_eur: got.length * unit };
      },
      { paidEnabled: true, runCostCeilingEur: ceiling, meta: { stage: 'e3_email_verify', chunk: String(i / chunkSize) } },
    );
    if (!items) {
      logger.warn({ chunk: i / chunkSize }, '[email_verify] chunk gated/failed — remaining emails keep no status');
      break;
    }
    if (probe) {
      console.log('\n===== PROBE email_verify — first raw item =====');
      console.log(JSON.stringify(items[0], null, 2).slice(0, 2000));
    }
    for (const raw of items) {
      const r = ApifyProvider.parseEmailVerifyItem(raw);
      if (r.email) {
        statusByEmail.set(r.email, r.status);
        verified += 1;
      }
    }
    logger.info({ done: Math.min(i + chunkSize, batch.length), of: batch.length, ledgerEur: run.ledger.getTotal().toFixed(2) }, '[email_verify] chunk done');
  }

  // ---- fan-out to leads (email_status is a run-style field: always written when known) ----
  const dist: Record<string, number> = {};
  for (const lead of leads) {
    const e = leadEmail(lead);
    if (!e) continue;
    const status = statusByEmail.get(e);
    if (status) {
      lead.email_status = status;
      dist[status] = (dist[status] ?? 0) + 1;
    }
  }

  const total = closeLedger(run, 'email_verify');
  if (probe) {
    console.log(`PROBE: verificate ${verified}/${batch.length}; distribuzione parsed: ${JSON.stringify(dist)}; ledger €${total.toFixed(3)}. Stato NON salvato.`);
    return;
  }
  await saveState(leads, out);
  console.log(
    `email_verify: ${emails.size} email uniche → pec ${pecCount} · no-MX ${noMx} · actor ${verified} · distribuzione lead ${JSON.stringify(dist)} · ledger €${total.toFixed(2)}`,
  );
}

runIfMain('email_verify.ts', main);
