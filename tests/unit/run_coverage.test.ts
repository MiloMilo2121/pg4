import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Checkpoint } from '../../src/runtime/checkpoint';
import { hasVerifiedPgEmptyResults } from '../../src/discovery/sources/pg_live';
import {
  CoverageContractError,
  classifyRecoveryError,
  completionMarkerPath,
  coverageManifestPath,
  isCompletedOutput,
  recoveryEnvelopePath,
  writeCoverageArtifacts,
} from '../../src/runtime/run_coverage';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg4-coverage-'));
  dirs.push(dir);
  const outCsv = path.join(dir, 'raw.csv');
  // The completion contract requires the same artifacts emitted by the live
  // pipeline: CSV header can be the sole content for a verified-empty run,
  // while JSONL is legitimately empty.
  fs.writeFileSync(outCsv, 'company_name\n');
  fs.writeFileSync(outCsv.replace(/\.csv$/i, '.jsonl'), '');
  const checkpoint = new Checkpoint(path.join(dir, 'raw.checkpoint.json'));
  return { dir, outCsv, checkpoint };
}

describe('run coverage manifest', () => {
  it('writes a completion marker only when every checkpointed query succeeded', () => {
    const { outCsv, checkpoint } = fixture();
    checkpoint.set('maps:centro estetico:belluno', { status: 'done', parsed: 0, attempts: 1, empty_verified: true });
    checkpoint.set('pg:agenzie immobiliari:belluno:p1', { status: 'done', parsed: 3, attempts: 2 });

    const manifest = writeCoverageArtifacts({ outCsv, runId: 'run-ok', checkpoint });

    expect(manifest.status).toBe('complete');
    expect(manifest.queries.map((query) => query.status)).toEqual(['empty_verified', 'success']);
    expect(isCompletedOutput(outCsv)).toBe(true);
    expect(fs.existsSync(coverageManifestPath(outCsv))).toBe(true);
    expect(fs.existsSync(completionMarkerPath(outCsv))).toBe(true);
    expect(fs.existsSync(recoveryEnvelopePath(outCsv))).toBe(false);
  });

  it('keeps partial output non-complete and emits a compact recovery envelope', () => {
    const { dir, outCsv, checkpoint } = fixture();
    checkpoint.set('maps:barbiere:belluno', {
      status: 'failed', reason: 'no_feed', attempts: 4, evidence_fingerprint: 'abc123',
      url: 'https://www.google.com/maps/search/barbiere+belluno', page_title: 'Access denied',
      screenshot_path: path.join(dir, 'raw.diagnostics', 'maps_barbiere_belluno.png'),
    });

    const manifest = writeCoverageArtifacts({ outCsv, runId: 'run-partial', checkpoint });
    const envelope = JSON.parse(fs.readFileSync(recoveryEnvelopePath(outCsv), 'utf8')) as {
      failures: Array<{ error_class: string; evidence_fingerprint: string; url: string; page_title: string; screenshot_path: string }>;
    };

    expect(manifest.status).toBe('partial');
    expect(manifest.failed_query_count).toBe(1);
    expect(isCompletedOutput(outCsv)).toBe(false);
    expect(fs.existsSync(completionMarkerPath(outCsv))).toBe(false);
    expect(envelope.failures).toHaveLength(1);
    expect(envelope.failures[0]).toMatchObject({
      error_class: 'maps_no_feed', evidence_fingerprint: 'abc123', key: 'maps:barbiere:belluno',
      url: 'https://www.google.com/maps/search/barbiere+belluno', page_title: 'Access denied',
      screenshot_path: 'raw.diagnostics/maps_barbiere_belluno.png',
    });
  });

  it('bounds a recovery envelope while retaining the full failure count in local coverage', () => {
    const { outCsv, checkpoint } = fixture();
    for (let index = 0; index < 25; index += 1) {
      checkpoint.set(`maps:barbiere:comune-${index}`, {
        status: 'failed', attempts: 1, reason: 'x'.repeat(1_000),
        url: `https://example.test/${'u'.repeat(2_100)}`,
      });
    }

    const manifest = writeCoverageArtifacts({ outCsv, runId: 'bounded-envelope', checkpoint });
    const envelope = JSON.parse(fs.readFileSync(recoveryEnvelopePath(outCsv), 'utf8')) as {
      total_failed_query_count: number;
      failures_truncated: boolean;
      failures: Array<{ reason?: string; url?: string }>;
    };

    expect(manifest.failed_query_count).toBe(25);
    expect(envelope).toMatchObject({ total_failed_query_count: 25, failures_truncated: true });
    expect(envelope.failures).toHaveLength(20);
    expect(envelope.failures[0].reason).toHaveLength(800);
    expect(envelope.failures[0].url).toHaveLength(2_048);
  });

  it('never creates a completion marker for pending or interrupted work', () => {
    const { outCsv, checkpoint } = fixture();
    checkpoint.set('pg:agenzie immobiliari:belluno:p1', { status: 'pending', page: 1, attempts: 0 });

    const pending = writeCoverageArtifacts({ outCsv, runId: 'run-pending', checkpoint });
    expect(pending.status).toBe('partial');
    expect(pending.failed_query_count).toBe(1);
    expect(pending.queries[0]).toMatchObject({ status: 'failed', error_class: 'checkpoint_integrity', attempts: 0 });
    expect(isCompletedOutput(outCsv)).toBe(false);

    checkpoint.clear();
    const interrupted = writeCoverageArtifacts({ outCsv, runId: 'run-interrupted', checkpoint, forcePartial: true });
    expect(interrupted).toMatchObject({ status: 'partial', failed_query_count: 0, incomplete_reason: 'interrupted' });
    expect(fs.existsSync(completionMarkerPath(outCsv))).toBe(false);
    expect(fs.existsSync(recoveryEnvelopePath(outCsv))).toBe(false);
  });

  it('does not dispatch a recovery incident while shutdown makes the diagnosis unstable', () => {
    const { outCsv, checkpoint } = fixture();
    checkpoint.set('maps:barbiere:belluno', { status: 'failed', reason: 'no_feed', attempts: 1 });

    const manifest = writeCoverageArtifacts({ outCsv, runId: 'shutdown-with-failure', checkpoint, forcePartial: true });

    expect(manifest).toMatchObject({ status: 'partial', incomplete_reason: 'interrupted', failed_query_count: 1 });
    expect(fs.existsSync(recoveryEnvelopePath(outCsv))).toBe(false);
  });

  it('rejects a copied or malformed completion marker', () => {
    const { outCsv, checkpoint } = fixture();
    checkpoint.set('pg:agenzie immobiliari:belluno:p1', { status: 'done', parsed: 1 });
    writeCoverageArtifacts({ outCsv, runId: 'run-ok', checkpoint });
    expect(isCompletedOutput(outCsv)).toBe(true);

    const markerPath = completionMarkerPath(outCsv);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.output_csv = path.join(path.dirname(outCsv), 'other.csv');
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    expect(isCompletedOutput(outCsv)).toBe(false);

    marker.output_csv = path.resolve(outCsv);
    marker.queries = [];
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    expect(isCompletedOutput(outCsv)).toBe(false);

    marker.queries = [{
      key: 'pg:agenzie immobiliari:belluno:p1', provider: 'pg', category: 'agenzie immobiliari',
      location: 'belluno', page: 1, status: 'pending', attempts: 1,
    }];
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    expect(isCompletedOutput(outCsv)).toBe(false);

    marker.queries = [{
      key: 'pg:agenzie immobiliari:belluno:p1', provider: 'pg', category: 'agenzie immobiliari',
      location: 'belluno', page: 1, status: 'success', attempts: 1,
    }];
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    fs.unlinkSync(outCsv);
    expect(isCompletedOutput(outCsv)).toBe(false);
  });

  it('treats a legacy done/zero checkpoint as a recovery failure, never verified emptiness', () => {
    const { outCsv, checkpoint } = fixture();
    checkpoint.set('maps:centro estetico:belluno', { status: 'done', parsed: 0, attempts: 1 });

    const manifest = writeCoverageArtifacts({ outCsv, runId: 'legacy-zero', checkpoint });

    expect(manifest).toMatchObject({ status: 'partial', failed_query_count: 1 });
    expect(manifest.queries[0]).toMatchObject({ status: 'failed', error_class: 'selector_drift' });
    expect(isCompletedOutput(outCsv)).toBe(false);
  });

  it('requires the completion marker to agree with its separate coverage manifest', () => {
    const { outCsv, checkpoint } = fixture();
    checkpoint.set('pg:agenzie immobiliari:belluno:p1', { status: 'done', parsed: 1, attempts: 1 });
    writeCoverageArtifacts({ outCsv, runId: 'matching-manifests', checkpoint });

    fs.unlinkSync(coverageManifestPath(outCsv));
    expect(isCompletedOutput(outCsv)).toBe(false);
  });

  it('refuses to write a complete marker when no terminal source query exists', () => {
    const { outCsv, checkpoint } = fixture();
    expect(() => writeCoverageArtifacts({ outCsv, runId: 'no-queries', checkpoint })).toThrow(CoverageContractError);
  });

  it('fails closed when checkpoint keys cannot be mapped to resumable source queries', () => {
    const { outCsv, checkpoint } = fixture();
    checkpoint.set('pg:agenzie immobiliari:belluno:pnot-a-page', { status: 'failed', attempts: 1, reason: 'timeout' });

    expect(() => writeCoverageArtifacts({ outCsv, runId: 'invalid-key', checkpoint })).toThrow(
      'unparseable checkpoint key',
    );
    expect(fs.existsSync(completionMarkerPath(outCsv))).toBe(false);
  });

  it('classifies known failure families without treating verified emptiness as a failure', () => {
    expect(classifyRecoveryError('page.goto: Timeout 32000ms exceeded')).toBe('network_exhausted');
    expect(classifyRecoveryError('no_feed')).toBe('maps_no_feed');
    expect(classifyRecoveryError('cookie consent wall')).toBe('consent_wall');
    expect(classifyRecoveryError('captcha unusual traffic')).toBe('blocked_or_captcha');
    expect(classifyRecoveryError('new selector matched 0 elements')).toBe('selector_drift');
    expect(classifyRecoveryError('maps_preflight_no_feed')).toBe('maps_no_feed');
    expect(classifyRecoveryError('parser_dropped_all_cards')).toBe('selector_drift');
    expect(classifyRecoveryError('blocked_or_captcha_no_feed')).toBe('blocked_or_captcha');
  });
});

describe('verified PG empty result guard', () => {
  it('does not turn an arbitrary blank/block page into a verified empty query', () => {
    expect(hasVerifiedPgEmptyResults('<main><h1>Access denied</h1></main>')).toBe(false);
    expect(hasVerifiedPgEmptyResults('<main>Nessun risultato trovato per questa ricerca</main>')).toBe(true);
  });
});
