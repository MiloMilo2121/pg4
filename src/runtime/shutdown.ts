/**
 * Graceful shutdown for long-lived servers (dev API, MCP). On SIGINT/SIGTERM
 * run `cleanup` — stop accepting, drain in-flight work, kill child jobs —
 * bounded by `timeoutMs`, then exit (0 on a clean drain, 1 on failure or
 * timeout). A second signal while draining exits immediately.
 *
 * Writes to stderr, never stdout: the MCP server speaks JSON-RPC on stdout.
 */
export interface ShutdownOptions {
  timeoutMs?: number;
  /** Injectable for tests. */
  exit?: (code: number) => void;
  signals?: readonly NodeJS.Signals[];
}

export function onShutdownSignal(name: string, cleanup: () => Promise<void>, opts: ShutdownOptions = {}): () => void {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const signals = opts.signals ?? (['SIGINT', 'SIGTERM'] as const);
  let draining = false;

  const handler = (signal: NodeJS.Signals): void => {
    if (draining) {
      process.stderr.write(`[${name}] ${signal} again — forcing exit\n`);
      exit(1);
      return;
    }
    draining = true;
    process.stderr.write(`[${name}] ${signal} — shutting down (max ${timeoutMs}ms)\n`);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`drain exceeded ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
    });
    Promise.race([cleanup(), deadline])
      .then(
        () => exit(0),
        (err: unknown) => {
          process.stderr.write(`[${name}] shutdown incomplete: ${err instanceof Error ? err.message : String(err)}\n`);
          exit(1);
        },
      )
      .finally(() => clearTimeout(timer));
  };

  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
