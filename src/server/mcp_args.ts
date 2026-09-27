import fs from 'fs';
import path from 'path';

/**
 * SDK-free helpers for the MCP server: argv building and path sandboxing.
 * mcp_server.ts registers tools at import time (it needs the SDK + stdio), so
 * the security-relevant logic lives here where it can be unit-tested.
 */

/**
 * Append `--name value` (or a bare `--name` for `true`) to argv. Skips
 * undefined and false. Mutates and returns argv for chaining.
 */
export function pushFlag(
  argv: string[],
  name: string,
  value: string | number | boolean | undefined,
): string[] {
  if (value === undefined || value === false) return argv;
  argv.push(`--${name}`);
  if (value !== true) argv.push(String(value));
  return argv;
}


/** A path an MCP agent supplied that falls outside what the tool may touch. */
export class SandboxViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxViolation';
  }
}

/** realpath of `p`, or of its deepest existing ancestor + the not-yet-existing tail. */
function realpathLenient(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Resolve an agent-supplied path (relative to `root`) and prove it stays inside
 * `allowedDir`. The MCP client is untrusted, so this rejects:
 *   - traversal (`../`, absolute paths elsewhere)
 *   - symlink escapes (compared on realpath, also for not-yet-existing outputs)
 *   - dot-segments (`.env`, `.git/…`, `.browser-state/…`) — secrets live there
 *   - extensions outside `opts.extensions`, when given
 * Returns the resolved absolute path.
 */
export function resolveSandboxedPath(
  root: string,
  allowedDir: string,
  candidate: string,
  opts: { extensions?: readonly string[] } = {},
): string {
  if (!candidate || candidate.includes('\0')) throw new SandboxViolation('empty or invalid path');
  const abs = path.resolve(root, candidate);
  const base = path.resolve(root, allowedDir);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SandboxViolation(`path must stay inside ${path.relative(root, base) || '.'}/`);
  }
  if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) throw new SandboxViolation('hidden files/dirs are off-limits');
  const realRel = path.relative(realpathLenient(base), realpathLenient(abs));
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new SandboxViolation('symlink escapes the sandbox');
  if (opts.extensions && !opts.extensions.includes(path.extname(abs).toLowerCase())) {
    throw new SandboxViolation(`only ${opts.extensions.join(', ')} files are allowed`);
  }
  return abs;
}
