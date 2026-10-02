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
    // The preamble is everything from the job header up to the first named
    // step — i.e. checkout, pnpm setup, node setup and `pnpm install`. Anchor
    // on the step name, never on an action version: a version string moves on
    // every Dependabot bump, and a slice anchored on one silently becomes the
    // whole rest of the file when the anchor is missing, which makes the
    // assertion pass or fail for the wrong reason.
    const jobStart = workflow.indexOf('  diagnose-fix-review:');
    const firstNamedStep = workflow.indexOf('      - name:', jobStart);

    expect(jobStart).toBeGreaterThan(-1);
    expect(firstNamedStep).toBeGreaterThan(jobStart);

    const jobPreamble = workflow.slice(jobStart, firstNamedStep);
    expect(jobPreamble).toContain('uses: actions/checkout@');
    expect(jobPreamble).not.toContain('OPENROUTER_API_KEY');

    expect(stepBlock('Mechanical pre-review')).not.toContain('OPENROUTER_API_KEY');
  });

  it('pins every action in the workflow to a commit SHA', () => {
    // A tag is a mutable ref: whoever owns the upstream repo can repoint
    // `v4` at new code, and the recovery agent would then run it with a
    // repository secret in the environment.
    const uses = workflow.match(/uses:\s*([^\s#]+)/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      const ref = use.replace(/uses:\s*/, '');
      expect(ref, `${ref} is not pinned to a SHA`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('pins every action in every workflow to a commit SHA', () => {
    // Same threat as above, repo-wide: the CodeQL and Scorecard workflows get
    // `id-token: write` and `security-events: write`, which is strictly more
    // authority than the recovery agent has.
    const dir = path.resolve('.github/workflows');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const use of text.match(/uses:\s*([^\s#]+)/g) ?? []) {
        const ref = use.replace(/uses:\s*/, '');
        expect(ref, `${file}: ${ref} is not pinned to a SHA`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
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
