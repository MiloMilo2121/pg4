import { execFile } from 'child_process';
import { logger } from './logger';

/**
 * Phase A.5 — pluggable operator notifications.
 *
 * Call sites emit structured events; the active notifier decides delivery.
 * Default is `local`: a structured log line at warn level (which also lands
 * in the per-run log file) plus a best-effort macOS notification via
 * osascript. Slack/Telegram/email can be added later by implementing
 * `Notifier` and extending `createNotifier` — no call-site changes.
 *
 * Selection: env `NOTIFY=local|off` (default `local`).
 * Conservative default recorded in docs/decision_log.md.
 */

export type NotifyKind =
  | 'run_complete'
  | 'run_failed'
  | 'run_interrupted'
  | 'preflight_failed'
  | 'cost_ceiling_hit'
  | 'run_cost_ceiling_hit'
  | 'yield_anomaly'
  | 'validation_failed'
  | 'provider_dead';

export interface NotifyEvent {
  kind: NotifyKind;
  title: string;
  body: string;
  meta?: Record<string, string | number | boolean | undefined>;
}

export interface Notifier {
  notify(event: NotifyEvent): void;
}

class LocalNotifier implements Notifier {
  notify(event: NotifyEvent): void {
    // Structured event in the log stream → also persisted to the run log file.
    logger.warn({ notify: event.kind, ...event.meta }, `[notify] ${event.title}: ${event.body}`);
    if (process.platform === 'darwin') {
      // Best-effort, fire-and-forget. Never blocks or throws.
      const script = `display notification ${JSON.stringify(event.body)} with title ${JSON.stringify(`pg4 — ${event.title}`)}`;
      try {
        execFile('osascript', ['-e', script], () => {
          /* outcome irrelevant */
        });
      } catch {
        /* osascript unavailable */
      }
    }
  }
}

class NoopNotifier implements Notifier {
  notify(): void {
    /* NOTIFY=off */
  }
}

export function createNotifier(mode: string | undefined = process.env.NOTIFY): Notifier {
  const m = (mode ?? 'local').trim().toLowerCase();
  if (m === 'off' || m === '0' || m === 'false' || m === 'none') return new NoopNotifier();
  return new LocalNotifier();
}

let singleton: Notifier | null = null;

export function getNotifier(): Notifier {
  if (!singleton) singleton = createNotifier();
  return singleton;
}

/** Test seam. */
export function setNotifier(n: Notifier | null): void {
  singleton = n;
}
