import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');

describe('CI dependency-audit gate', () => {
  it('uses the supported exact production-graph audit instead of pnpm 10 legacy audit endpoints', () => {
    expect(workflow).toContain('node scripts/audit_prod_dependencies.mjs .');
    expect(workflow).toContain('node scripts/audit_prod_dependencies.mjs web');
    expect(workflow).not.toContain('pnpm audit');
  });
});
