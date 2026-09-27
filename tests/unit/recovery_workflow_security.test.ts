import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(path.resolve('.github/workflows/recovery-agent.yml'), 'utf8');

function stepBlock(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}`);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

describe('recovery workflow secret boundary', () => {
  it('does not expose OpenRouter credentials to install, tests, or lint', () => {
    const jobPreamble = workflow.slice(
      workflow.indexOf('  diagnose-fix-review:'),
      workflow.indexOf('      - uses: actions/checkout@v4'),
    );

    expect(jobPreamble).not.toContain('OPENROUTER_API_KEY');
    expect(stepBlock('Mechanical pre-review')).not.toContain('OPENROUTER_API_KEY');
  });

  it('scopes the credential to the two model invocation steps only', () => {
    for (const name of ['Generate constrained patch', 'Independent AI pre-review']) {
      const block = stepBlock(name);
      expect(block).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}');
      expect(block).toContain('OPENROUTER_MODEL: anthropic/claude-opus-4-8');
    }
  });

  it('the LLM job only opens the PR — it never merges', () => {
    const patchJob = workflow.slice(workflow.indexOf('  diagnose-fix-review:'), workflow.indexOf('\n  merge:'));
    expect(patchJob).not.toContain('gh pr merge');
    const prStep = stepBlock('Commit and create PR');
    expect(prStep).toContain('GH_TOKEN: ${{ secrets.RECOVERY_GH_TOKEN }}');
    expect(prStep).toContain('gh auth setup-git');
    expect(workflow).not.toContain('GH_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('persist-credentials: false');
  });

  it('merges only from the protected environment, after checks, pinned to the reviewed commit', () => {
    const mergeJob = workflow.slice(workflow.indexOf('\n  merge:'));
    expect(workflow.match(/gh pr merge/g)).toHaveLength(1);
    expect(mergeJob).toContain('environment: recovery-merge');
    expect(mergeJob).toContain('needs: diagnose-fix-review');
    expect(mergeJob).toContain('gh pr checks "$PR_URL" --watch --fail-fast');
    expect(mergeJob).toContain('--match-head-commit "$HEAD_SHA"');
    expect(mergeJob).not.toContain('--admin');
  });

  it('labels each dispatched recovery cycle so the VPS cannot resume against an older run', () => {
    expect(workflow).toContain('attempt ${{ github.event.client_payload.recovery_attempt || \'manual\' }}');
  });

  it('materializes a schema-checked manual envelope without interpolating event values into shell', () => {
    const materialize = stepBlock('Materialize sanitized incident envelope');
    const runScript = materialize.slice(materialize.indexOf('        run: |'));
    expect(workflow).toContain('incident_envelope:');
    expect(materialize).toContain('REQUESTED_INCIDENT_ID: ${{ github.event.client_payload.incident_id || inputs.incident_id }}');
    expect(runScript).not.toContain('${{');
    expect(materialize).toContain('invalid compact recovery envelope');
  });

  it('serializes duplicate deliveries for the same incident instead of racing two patches', () => {
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('group: recovery-${{ github.event.client_payload.incident_id || inputs.incident_id || github.run_id }}');
    expect(workflow).toContain('cancel-in-progress: false');
  });
});
