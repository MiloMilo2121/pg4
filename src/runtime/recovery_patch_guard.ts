/**
 * Trust boundary for patches returned by the hosted recovery model.
 *
 * The model output is untrusted input: a valid-looking unified diff can delete
 * a forbidden file without ever containing a `+++ b/...` line. Validate both
 * sides of every diff header before passing it to `git apply`.
 */

const ALLOWED_PATH_PREFIXES = [
  'src/discovery/sources/',
  'src/browser/consent_handler.ts',
  'src/runtime/retry.ts',
  'src/runtime/checkpoint.ts',
  'src/runtime/page_evidence.ts',
  'tests/unit/',
] as const;

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
  const allowed = ALLOWED_PATH_PREFIXES.some((prefix) => prefix.endsWith('/') ? relativePath.startsWith(prefix) : relativePath === prefix);
  if (!allowed) {
    throw new Error(`recovery patch touches forbidden path: ${relativePath}`);
  }
}

function assertHeaderPath(value: string, expectedPrefix: 'a/' | 'b/'): void {
  const filePath = value.split('\t', 1)[0];
  if (filePath === '/dev/null') return;
  if (!filePath.startsWith(expectedPrefix)) {
    throw new Error(`recovery patch has an invalid file header: ${value}`);
  }
  assertAllowedRelativePath(filePath.slice(expectedPrefix.length));
}

/** Reject a patch before it reaches `git apply`. */
export function assertSafeRecoveryPatch(patch: string): void {
  if (!patch || !patch.includes('diff --git ')) {
    throw new Error('recovery agent did not return a unified diff');
  }

  let diffHeaders = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(line);
      if (!match) throw new Error(`recovery patch has an invalid diff header: ${line}`);
      assertAllowedRelativePath(match[1]);
      assertAllowedRelativePath(match[2]);
      diffHeaders += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      assertHeaderPath(line.slice(4), 'a/');
      continue;
    }
    if (line.startsWith('+++ ')) {
      assertHeaderPath(line.slice(4), 'b/');
      continue;
    }
    if (/^(?:(?:new|deleted|old) file mode|(?:new|old) mode) 120000$|^GIT binary patch$|^Binary files /.test(line)) {
      throw new Error('recovery patch may not add, remove, or modify binary/symlink files');
    }
    if (line.startsWith('+') && !line.startsWith('+++') && FORBIDDEN_ADDED_TEXT.some((rule) => rule.test(line.slice(1)))) {
      throw new Error('recovery patch contains forbidden bypass, credential, or network-capable code');
    }
  }

  if (diffHeaders === 0) throw new Error('recovery agent did not return a valid unified diff');
}
