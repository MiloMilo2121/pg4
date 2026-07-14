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
  });

  it('labels each dispatched recovery cycle so the VPS cannot resume against an older run', () => {
    expect(workflow).toContain('attempt ${{ github.event.client_payload.recovery_attempt || \'manual\' }}');
  });
});
