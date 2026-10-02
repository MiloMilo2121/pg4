/**
 * Trust boundary for patches returned by the hosted recovery model.
 *
 * The model output is untrusted input: a valid-looking unified diff can delete
 * a forbidden file without ever containing a `+++ b/...` line. Validate both
 * sides of every diff header before passing it to `git apply`.
 */

const ALLOWED_PRODUCTION_PATHS = new Set([
  // Browser navigators and their parsers are the recovery surface for
  // selector drift, no-feed, and parser-drop incidents. Preflight remains
  // read-only: it consumes these selector exports, so an agent can repair a
  // selector without weakening the preflight safety gate. Keep this explicit:
  // the source directory also contains unrelated geography/detail harvesters.
  'src/discovery/sources/maps_live.ts',
  'src/discovery/sources/pagine_gialle_live.ts',
  'src/discovery/sources/google_maps_parser.ts',
  'src/discovery/sources/pagine_gialle_parser.ts',
  'src/discovery/sources/category_match.ts',
  'src/browser/consent_handler.ts',
  'src/runtime/retry.ts',
  'src/runtime/checkpoint.ts',
  'src/runtime/page_evidence.ts',
]);

const FORBIDDEN_ADDED_TEXT = [
  /--skip-preflight/i,
  /(?:OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN)/i,
  /\.github\/workflows/i,
  /process\.env\b/i,
  /\bchild_process\b/i,
  /\b(?:execFileSync|execSync|spawnSync|spawn|execFile|exec)\s*\(/i,
  /\bfetch\s*\(/i,
  /https?:\/\//i,
  /(?:from|require\()\s*['"](?:node:)?(?:https?|net|tls|dgram|child_process)['"]/i,
];

function assertAllowedRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.includes('..') || relativePath.startsWith('/') || relativePath.includes('\\')) {
    throw new Error(`recovery patch contains an unsafe path: ${relativePath}`);
  }
  const allowed = relativePath.startsWith('tests/unit/') || ALLOWED_PRODUCTION_PATHS.has(relativePath);
  if (!allowed) {
    throw new Error(`recovery patch touches forbidden path: ${relativePath}`);
  }
}

function headerRelativePath(value: string, expectedPrefix: 'a/' | 'b/'): string | '/dev/null' {
  const filePath = value.split('\t', 1)[0];
  if (filePath === '/dev/null') return '/dev/null';
  if (!filePath.startsWith(expectedPrefix)) {
    throw new Error(`recovery patch has an invalid file header: ${value}`);
  }
  const relativePath = filePath.slice(expectedPrefix.length);
  assertAllowedRelativePath(relativePath);
  return relativePath;
}

interface DiffState {
  from: string;
  to: string;
  oldHeader?: string | '/dev/null';
  newHeader?: string | '/dev/null';
  newFile?: boolean;
}

function assertCompleteDiff(state: DiffState | undefined): void {
  if (!state) return;
  if (state.oldHeader === undefined || state.newHeader === undefined) {
    throw new Error('recovery patch is missing a complete unified-diff header pair');
  }
  if (state.newHeader === '/dev/null') {
    throw new Error('recovery patch may not delete files');
  }
  if (state.oldHeader === '/dev/null') {
    if (!state.newFile || !state.to.startsWith('tests/unit/') || state.newHeader !== state.to) {
      throw new Error('recovery patch may only add a new unit regression test');
    }
    return;
  }
  if (state.newFile || state.oldHeader !== state.from || state.newHeader !== state.to) {
    throw new Error('recovery patch has mismatched or unsafe file headers');
  }
}

/** Reject a patch before it reaches `git apply`. */
export function assertSafeRecoveryPatch(patch: string): void {
  if (!patch || !patch.includes('diff --git ')) {
    throw new Error('recovery agent did not return a unified diff');
  }

  let diffHeaders = 0;
  let current: DiffState | undefined;
  let hasRegressionTestAddition = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      assertCompleteDiff(current);
      const match = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(line);
      if (!match) throw new Error(`recovery patch has an invalid diff header: ${line}`);
      assertAllowedRelativePath(match[1]);
      assertAllowedRelativePath(match[2]);
      current = { from: match[1], to: match[2] };
      diffHeaders += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!current) throw new Error('recovery patch has a file header outside a diff block');
      current.oldHeader = headerRelativePath(line.slice(4), 'a/');
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!current) throw new Error('recovery patch has a file header outside a diff block');
      current.newHeader = headerRelativePath(line.slice(4), 'b/');
      continue;
    }
    if (/^(similarity index |rename from |rename to |copy from |copy to |deleted file mode |old mode |new mode |GIT binary patch$|Binary files )/.test(line)) {
      throw new Error('recovery patch may not rename, copy, delete, or change file modes');
    }
    if (line.startsWith('new file mode ')) {
      if (!current || line !== 'new file mode 100644') {
        throw new Error('recovery patch may only add a regular-text unit test file');
      }
      current.newFile = true;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++') && current?.to.startsWith('tests/unit/')) {
      hasRegressionTestAddition = true;
    }
    if (line.startsWith('+') && !line.startsWith('+++') && FORBIDDEN_ADDED_TEXT.some((rule) => rule.test(line.slice(1)))) {
      throw new Error('recovery patch contains forbidden bypass, credential, or network-capable code');
    }
  }

  if (diffHeaders === 0) throw new Error('recovery agent did not return a valid unified diff');
  assertCompleteDiff(current);
  if (!hasRegressionTestAddition) throw new Error('recovery patch must add a focused unit regression assertion');
}
