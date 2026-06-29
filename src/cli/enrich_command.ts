import { logger } from '../runtime/logger';
import { readCsvAsLeads } from '../io/csv_reader';
import { OutputManager } from '../io/output_manager';
import { createRun, createPerLeadContext } from '../runtime/run_context';
import { buildProviderCatalog } from '../providers/provider_catalog';
import { runEnrichmentPipeline } from '../enrichment/enrichment_pipeline';
import { PgDetailHarvester } from '../discovery/sources/pagine_gialle_detail_harvester';
import { acquireOutputLock } from '../runtime/output_lock';
import { buildMockHttpRouter, buildNoopPgDetailHarvester } from './mock_http';
import { getNotifier } from '../runtime/notifier';
import { reportProviderHealth } from '../runtime/provider_health';

/**
 * Phase B.1 — the enrich core, extracted from the CLI so the `run` command
 * can chain scrape → enrich with one shared run id and so tests can drive
 * the full command without spawning a process.
 *
 * Owns: output lock, run context, provider router, concurrency loop,
 * ledger summary, cost-event notifications. Does NOT own: arg parsing,
 * run-record lifecycle, exit codes — those stay in the CLI wrapper.
 */

export interface EnrichCommandOptions {
  input: string;
  csvOut: string;
  mockHttpPath?: string;
  ledgerPath?: string;
  costCeilingEur?: number;
  runCostCeilingEur?: number;
  enablePaid?: boolean;
  /** Phase B.1 — shared run id from the `run` command. */
  runId?: string;
  /** Phase B.5 — cooperative cancellation. */
  abortSignal?: AbortSignal;
  /**
   * Phase C.4 — enrich leads Maps marked "Chiuso definitivamente".
   * Default false: closed businesses are written as SKIPPED without
   * burning provider calls on them.
   */
  includeClosed?: boolean;
  /**
   * Phase D.1 — do-not-contact suppression. Matching leads are dropped
   * from the outputs entirely (counted in the summary + run record).
   */
  suppression?: import('../compliance/suppression').SuppressionList;
}

export interface EnrichCommandResult {
  runId: string;
  total: number;
  withWebsite: number;
  errors: number;
  /** Phase C.4 — leads skipped because Maps marked them permanently closed. */
  skippedClosed: number;
  /** Phase D.1 — leads dropped by the suppression list. */
  suppressed: number;
  totalCostEur: number;
  /** Leads whose per-lead paid budget was exhausted mid-pipeline. */
  budgetExhaustedLeads: number;
  jsonlOut: string;
  ledgerPath: string;
  interrupted: boolean;
  /** Gate-0 — providers that made ≥N calls but never succeeded this run. */
  providerDead: string[];
}

export async function runEnrichCommand(o: EnrichCommandOptions): Promise<EnrichCommandResult> {
  const jsonlOut = o.csvOut.replace(/\.csv$/i, '') + '.jsonl';
  const ledgerPath = o.ledgerPath ?? o.csvOut.replace(/\.csv$/i, '') + '.cost-ledger.jsonl';
  const outputLock = acquireOutputLock(o.csvOut, { input: o.input, jsonlOut, ledgerPath, command: 'enrich' });
  try {
    // Phase G — paid providers gate. Default DENY: paid is off unless
    // `--enable-paid` is passed. The cost-ceiling-eur=0 path also
    // forces paid off as an extra safety, so an operator can run
    // "free regression" by setting the ceiling to 0 even if they
    // forgot to drop --enable-paid.
    //
    // WS-E — PAID_DEFAULT_ON: when set in the env, paid escalation runs by
    // DEFAULT at a small per-lead cap (DEFAULT_PAID_CAP_EUR_PER_LEAD) so the
    // engine auto-escalates to Apify/Perplexity on leads the free ladder did
    // not resolve. The router's hard run-ceiling + per-lead budget still cap it.
    const { getEnv } = await import('../config/env');
    const env = getEnv();
    const paidDefaultOn = env.PAID_DEFAULT_ON === true && !o.mockHttpPath;
    const wantPaid = o.enablePaid === true || paidDefaultOn;
    // Effective per-lead ceiling: an explicit flag wins; else the default cap
    // when paid-default-on; else undefined (free).
    const effectiveCeiling = o.costCeilingEur ?? (paidDefaultOn ? env.DEFAULT_PAID_CAP_EUR_PER_LEAD : undefined);
    let paidEnabled = wantPaid && (effectiveCeiling === undefined || effectiveCeiling > 0);
    if (o.enablePaid && !paidEnabled) {
      logger.warn(
        { costCeiling: o.costCeilingEur },
        '[enrich] --enable-paid is ignored because --cost-ceiling-eur is 0; force-OFF paid for this run',
      );
    }
    // Phase B.4 — fail fast when paid was requested but no provider is usable.
    // For an EXPLICIT --enable-paid this is a hard error (the operator asked).
    // For PAID_DEFAULT_ON it degrades to a free run (warn, never break).
    if (paidEnabled && !o.mockHttpPath) {
      const { assertPaidSecrets } = await import('../config/env');
      try {
        assertPaidSecrets();
      } catch (err) {
        if (o.enablePaid) throw err;
        logger.warn({ err: (err as Error).message }, '[enrich] PAID_DEFAULT_ON but no usable paid key — running free');
        paidEnabled = false;
      }
    }
    if (paidDefaultOn && paidEnabled) {
      logger.info({ capEurPerLead: effectiveCeiling }, '[enrich] PAID_DEFAULT_ON — paid escalation active at default cap');
    }
    const run = createRun({
      ledgerJsonlPath: ledgerPath,
      costCeilingEur: effectiveCeiling,
      paidEnabled,
      runCostCeilingEur: o.runCostCeilingEur,
      runId: o.runId,
      abortSignal: o.abortSignal,
    });
    const notifier = getNotifier();
    const router = o.mockHttpPath ? buildMockHttpRouter(run.ledger, o.mockHttpPath) : buildProviderCatalog(run.ledger);
    // Phase A.5 — run-ceiling event. The router latches: fires once.
    router.setRunCeilingListener(({ ledgerTotalEur, ceilingEur }) => {
      notifier.notify({
        kind: 'run_cost_ceiling_hit',
        title: 'Run cost ceiling reached',
        body: `Paid providers disabled for the rest of the run (spent €${ledgerTotalEur.toFixed(4)} of €${ceilingEur}).`,
        meta: { run_id: run.ctx.runId, ledger_total_eur: ledgerTotalEur, ceiling_eur: ceilingEur },
      });
    });
    const dnsResolver = o.mockHttpPath ? async (_host: string): Promise<string[]> => [] : undefined;
    // R1 — shared harvester so duplicate `pg_url`s across leads only
    // hit the network once per run.
    const pgHarvester = o.mockHttpPath ? buildNoopPgDetailHarvester() : new PgDetailHarvester();

    const output = new OutputManager(o.csvOut, jsonlOut, 'enriched');
    logger.info(
      {
        runId: run.ctx.runId,
        input: o.input,
        csvOut: o.csvOut,
        paidEnabled,
        costCeilingEur: o.costCeilingEur,
        runCostCeilingEur: o.runCostCeilingEur,
      },
      '[enrich] starting',
    );
    if (o.mockHttpPath) {
      logger.info({ mockHttpPath: o.mockHttpPath }, '[enrich] using offline mock HTTP fixture');
    }

    let total = 0;
    let withWebsite = 0;
    let errors = 0;
    let skippedClosed = 0;
    let suppressed = 0;
    let budgetExhaustedLeads = 0;
    let firstBudgetNotified = false;
    let interrupted = false;
    const inFlight: Promise<void>[] = [];
    const concurrency = run.cfg.pipeline.concurrency;

    for await (const item of readCsvAsLeads(o.input)) {
      // Phase B.5 — cooperative abort: stop ingesting new rows; the
      // in-flight drain below finishes the rows already started so the
      // CSV/JSONL stay parseable and the ledger summary is written.
      if (o.abortSignal?.aborted) {
        interrupted = true;
        break;
      }
      total += 1;
      // Phase D.1 — suppression: a do-not-contact subject is dropped from
      // the output entirely, before any provider call.
      if (o.suppression?.matches(item.lead)) {
        suppressed += 1;
        continue;
      }
      // Phase C.4 — Maps flagged this business permanently closed: write
      // it as SKIPPED (row parity preserved) without burning provider
      // calls. CSV roundtrip stores booleans as the string "true".
      const closed = item.lead.permanently_closed === true || String(item.lead.permanently_closed) === 'true';
      if (closed && !o.includeClosed) {
        skippedClosed += 1;
        await output.write({
          ...item.lead,
          status: 'SKIPPED',
          reason_code: 'SKIPPED_PERMANENTLY_CLOSED',
        });
        continue;
      }
      const task = (async () => {
        const perLead = createPerLeadContext(run);
        try {
          const result = await runEnrichmentPipeline({
            run,
            perLead,
            router,
            lead: item.lead,
            ingestError: item.ingestError,
            dnsResolver,
            pgHarvester,
            isSuppressedEmail: o.suppression ? (e: string) => o.suppression!.matchesEmail(e) : undefined,
          });
          if (result.lead.official_website) withWebsite += 1;
          await output.write(result.lead, { stage_outcomes: result.stage_outcomes });
        } catch (err) {
          errors += 1;
          logger.error({ line: item.lineNumber, err: (err as Error).message }, '[enrich] row failed');
          await output.write({ ...item.lead, status: 'ERROR', reason_code: 'ERROR_INTERNAL', errors: [{ stage: 'pipeline', message: (err as Error).message }] });
        } finally {
          if (perLead.budgetExhausted) {
            budgetExhaustedLeads += 1;
            // Phase A.5 — per-lead ceiling event, notified once per run
            // (many leads legitimately exhaust their budget; one ping is
            // signal, N pings are spam). The full count lands in the
            // ledger summary + run record.
            if (!firstBudgetNotified) {
              firstBudgetNotified = true;
              notifier.notify({
                kind: 'cost_ceiling_hit',
                title: 'Per-lead cost ceiling hit',
                body: `At least one lead exhausted its paid budget (€${run.ctx.costCeilingEur}); further leads may follow (count in run summary).`,
                meta: { run_id: run.ctx.runId, ceiling_eur: run.ctx.costCeilingEur },
              });
            }
          }
        }
      })().finally(() => {
        const idx = inFlight.indexOf(task);
        if (idx >= 0) inFlight.splice(idx, 1);
      });
      inFlight.push(task);
      if (inFlight.length >= concurrency) {
        await Promise.race(inFlight);
      }
    }

    await Promise.all(inFlight);
    await output.close();
    if (suppressed > 0) {
      logger.warn({ suppressed, list: o.suppression?.sourcePath }, '[enrich] leads dropped by suppression list');
    }
    // Gate-0 — flag any provider that made calls but never succeeded this
    // run (the dns_mx/crtsh silent-failure class). Warn-only; never changes
    // the outcome. Computed before flushSummary so it lands in the summary.
    const providerDead = reportProviderHealth(run.ledger, { runId: run.ctx.runId });

    run.ledger.flushSummary({
      leads_processed: total,
      leads_with_website: withWebsite,
      leads_errored: errors,
      leads_skipped_closed: skippedClosed,
      leads_suppressed: suppressed,
      leads_budget_exhausted: budgetExhaustedLeads,
      interrupted,
      cost_per_lead_eur: total > 0 ? run.ledger.getTotal() / total : 0,
      cost_ceiling_eur: run.ctx.costCeilingEur,
      breaker: router.describeBreaker(),
      provider_dead: providerDead,
    });

    return {
      runId: run.ctx.runId,
      total,
      withWebsite,
      errors,
      skippedClosed,
      suppressed,
      totalCostEur: run.ledger.getTotal(),
      budgetExhaustedLeads,
      jsonlOut,
      ledgerPath,
      interrupted,
      providerDead,
    };
  } finally {
    outputLock.release();
  }
}
