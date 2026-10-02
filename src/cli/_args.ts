import { UserError } from '../runtime/errors';
import { EnvConfigError } from '../config/env';
import { logger } from '../runtime/logger';

/**
 * Minimal arg parser. Supports `--name=value`, `--name value`, and `--flag`.
 * Avoids pulling a dependency for the few CLI entries here.
 */
export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      flags.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { positional, flags };
}

export function hasHelp(args: ParsedArgs): boolean {
  return args.flags.help === true;
}

export function reqString(args: ParsedArgs, key: string, hint = ''): string {
  const v = args.flags[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new UserError(`Missing required --${key}${hint ? ` (${hint})` : ''}`);
  }
  return v;
}

export function optString(args: ParsedArgs, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Last-resort handler for CLI entry points. A user error (bad invocation,
 * missing input, invalid .env) prints one clear line plus a usage hint; an
 * unexpected failure is logged with its stack for debugging.
 */
export function reportFatal(command: string, err: unknown): void {
  if (err instanceof UserError) {
    process.stderr.write(`[${command}] ${err.message}\nRun \`pnpm ${command} --help\` for usage.\n`);
    return;
  }
  if (err instanceof EnvConfigError) {
    process.stderr.write(`[${command}] ${err.message}\n`);
    return;
  }
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error({ err: e.message, stack: e.stack }, `[${command}] fatal`);
}
