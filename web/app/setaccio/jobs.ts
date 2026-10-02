// FE↔BE wiring core. The action buttons (Arricchisci / Giudica / Mappa) call the
// real engine via web/lib/api.ts; this module owns the job-polling primitive and
// the cache-invalidation that makes the dashboard update live when a job finishes.
'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type EnrichJob, type JudgmentJob, type ScrapeJob, type ScrapeRequest } from '../../lib/api';
import type { ActiveJob, JobKind } from './data';

const JUDGMENT_KINDS: ReadonlyArray<JobKind> = ['discovery', 'collect_signals', 'judge', 'validate_export'];
const isJudgment = (k: JobKind): boolean => JUDGMENT_KINDS.includes(k);
const isTerminal = (s?: string): boolean => s === 'done' || s === 'partial' || s === 'error' || s === 'failed' || s === 'cancelled';

/** On a job's completion, which read-query keys to refetch so the UI updates live. */
const INVALIDATE_BY_KIND: Record<JobKind, string[]> = {
  enrich: ['companies', 'metrics', 'cost'],
  scrape: ['companies', 'metrics', 'markets', 'coverage', 'runs', 'cost', 'health'],
  discovery: ['companies', 'judgment-summary'],
  collect_signals: ['companies', 'judgment-summary'],
  judge: ['companies', 'judgment-summary'],
  validate_export: ['companies', 'judgment-summary'],
};

export type PolledJob = EnrichJob | JudgmentJob | ScrapeJob;

/**
 * Poll the active job until terminal (1.5s for enrich/judgment, 4s for the slow
 * scrape CLI), then invalidate the affected read queries exactly once. Returns
 * the live job payload for the progress modal. A single GET /api/jobs/:id serves
 * all three kinds, so one hook + a kind discriminator covers everything.
 */
export function useJobPolling(activeJob: ActiveJob | null) {
  const qc = useQueryClient();
  const id = activeJob?.id ?? null;
  const kind = activeJob?.kind ?? null;
  const judgment = kind ? isJudgment(kind) : false;
  const interval = kind === 'scrape' ? 2000 : 1500;

  const q = useQuery<PolledJob>({
    queryKey: ['job', id],
    queryFn: () => (kind === 'scrape' ? api.scrapeJob(id as string) : judgment ? api.judgmentJob(id as string) : api.job(id as string)),
    enabled: !!id,
    refetchInterval: (query) => (isTerminal(query.state.data?.status) ? false : interval),
    refetchOnWindowFocus: false,
    gcTime: 0,
  });

  const status = q.data?.status;
  // A running scrape ingests its rows as it goes: refresh the data views on
  // every poll so the counts grow live, not only when the job ends.
  const polledAt = q.dataUpdatedAt;
  useEffect(() => {
    if (kind !== 'scrape' || !polledAt || isTerminal(status)) return;
    for (const key of INVALIDATE_BY_KIND.scrape) qc.invalidateQueries({ queryKey: [key] });
  }, [kind, polledAt, status, qc]);

  const invalidatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !kind) return;
    if (isTerminal(status) && invalidatedFor.current !== id) {
      invalidatedFor.current = id;
      for (const key of INVALIDATE_BY_KIND[kind]) qc.invalidateQueries({ queryKey: [key] });
    }
  }, [id, kind, status, qc]);

  return { job: q.data, status, terminal: isTerminal(status), isLoading: q.isLoading, error: q.error };
}

// ---- mutations (the POSTs). The caller stores the returned jobId into the
// store via onSuccess, which starts useJobPolling + opens the progress modal. ----

export function useEnrichJob() {
  return useMutation({ mutationFn: ({ ids, fields }: { ids: string[]; fields: string[] }) => api.enrich(ids, fields) });
}

export function useScrapeJob() {
  return useMutation({ mutationFn: (body: ScrapeRequest) => api.scrape(body) });
}

export type JudgmentKind = 'discovery' | 'collect_signals' | 'judge' | 'validate_export';
export function useJudgmentJob(kind: JudgmentKind) {
  const fn = { discovery: api.discovery, collect_signals: api.collectSignals, judge: api.judge, validate_export: api.validateExport }[kind];
  return useMutation({ mutationFn: (companyIds: string[]) => fn(companyIds) });
}

/** Per-company verdict detail. retry:false so a 404 (unjudged) fails fast → honest empty state. */
export function useJudgmentDetail(companyId: string | null) {
  return useQuery({
    queryKey: ['judgment-detail', companyId],
    queryFn: () => api.judgmentDetail(companyId as string),
    enabled: !!companyId,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
