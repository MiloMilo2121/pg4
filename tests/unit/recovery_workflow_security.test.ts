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
      workflow.indexOf('  diagnose-fix-review-merge:'),
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

  it('waits for PR checks and pins the reviewed commit before auto-merging', () => {
    const mergeStep = stepBlock('Commit, create PR, auto-merge');
    expect(mergeStep).toContain('gh pr checks "$PR_URL" --watch --fail-fast');
    expect(mergeStep).toContain('--match-head-commit "$(git rev-parse HEAD)"');
    expect(mergeStep).not.toContain('--admin');
    expect(mergeStep).toContain('GH_TOKEN: ${{ secrets.RECOVERY_GH_TOKEN }}');
    expect(mergeStep).toContain('gh auth setup-git');
    expect(workflow).not.toContain('GH_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('persist-credentials: false');
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
