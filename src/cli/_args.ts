/**
 * Minimal arg parser. Supports `--name=value`, `--name value`, and `--flag`.
 * Avoids pulling a dependency for the few CLI entries pg4 has.
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
    throw new Error(`Missing required --${key}${hint ? ` (${hint})` : ''}`);
  }
  return v;
}

export function optString(args: ParsedArgs, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === 'string' ? v : undefined;
}
