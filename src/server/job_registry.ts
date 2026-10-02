/**
 * Retention for the dev API's in-memory job registries. A dashboard left open
 * for days keeps creating jobs, and every job holds its per-company items, so
 * finished jobs expire after a TTL and are capped in number. Running jobs are
 * never evicted: the UI is still polling them.
 */
export interface JobRetention {
  ttlMs: number;
  maxFinished: number;
}

const DEFAULT_JOB_RETENTION: JobRetention = { ttlMs: 60 * 60 * 1000, maxFinished: 200 };

export interface RetainableJob {
  status: string;
  /** Epoch ms when the job reached a terminal status. */
  finishedAt?: number;
}

export function evictFinishedJobs<J extends RetainableJob>(
  registry: Map<string, J>,
  now: number,
  retention: JobRetention = DEFAULT_JOB_RETENTION,
): void {
  const finished: Array<[string, number]> = [];
  for (const [id, job] of registry) {
    if (job.status === 'running') continue;
    const at = job.finishedAt ?? Number.NEGATIVE_INFINITY;
    if (now - at > retention.ttlMs) registry.delete(id);
    else finished.push([id, at]);
  }
  const excess = finished.length - retention.maxFinished;
  if (excess <= 0) return;
  finished.sort((a, b) => a[1] - b[1]);
  for (const [id] of finished.slice(0, excess)) registry.delete(id);
}
