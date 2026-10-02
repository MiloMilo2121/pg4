import fs from 'fs';
import path from 'path';

/**
 * Fase 5.2 — `npx tsx` a runtime è vietato: npx può toccare la rete e non
 * pinna la versione eseguita. I server (MCP, API) lanciano i CLI con il tsx
 * locale del repo; se il repo non ha node_modules (checkout senza install)
 * si ricade sul `tsx` risolto dal PATH. Mai una shell, mai npx.
 */

/** Absolute repo-local tsx when installed, else bare `tsx` from PATH. */
export function resolveTsxExecutable(repoRoot: string): string {
  const local = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  try {
    if (fs.existsSync(local)) return local;
  } catch {
    /* unreadable FS → PATH fallback below */
  }
  return 'tsx';
}

export interface TsxCommand {
  file: string;
  args: string[];
}

/**
 * `{ file, args }` ready for execFile/spawn with no shell and no npx.
 * `scriptAndArgs[0]` is the script (`src/cli/run.ts`), the rest its argv.
 * A legacy leading `tsx` (the old `spawn('npx', ['tsx', …])` shape the
 * dashboard scrape job still builds) is stripped so existing callers keep
 * working unchanged.
 */
export function buildTsxCommand(repoRoot: string, scriptAndArgs: readonly string[]): TsxCommand {
  const [first, ...rest] = scriptAndArgs;
  const args = first === 'tsx' ? [...rest] : [...scriptAndArgs];
  return { file: resolveTsxExecutable(repoRoot), args };
}
