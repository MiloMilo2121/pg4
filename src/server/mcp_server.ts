/**
 * pg4 MCP server — exposes the pipeline to agents over stdio with zero effort.
 *
 * Ported clean from pg3/src/mcp_server.ts. Two deliberate simplifications vs pg3:
 *  - Tools wrap pg4's REAL CLIs (src/cli/*) directly. pg3's `agent_tools/` shim
 *    layer is dropped — the CLI is already the stable contract.
 *  - execFile(argv[]) instead of exec(string) → no shell, no injection. The MCP
 *    client is an untrusted agent; arg values never touch a shell.
 *
 * Run: `pnpm run mcp`  (or `npx tsx src/server/mcp_server.ts`)
 *
 * The SDK's legacy `tool()` overload recursively infers every concrete Zod
 * shape. Across this server that exhausts TypeScript's heap before CI can
 * finish. `registerTool()` deliberately narrows that third-party boundary to
 * `Record<string, ZodTypeAny>` while retaining each handler's explicit local
 * input type and passing the original runtime Zod schemas unchanged.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { pushFlag, resolveSandboxedPath, SandboxViolation } from './mcp_args';
import { onShutdownSignal } from '../runtime/shutdown';

const execFileAsync = promisify(execFile);
const PG4_ROOT = path.resolve(__dirname, '..', '..'); // src/server -> pg4/
const MAX_OUTPUT = 32 * 1024 * 1024;
/** A CLI run longer than this is killed, so a hung pipeline never hangs the agent forever (generous: full province + Maps runs take hours). */
const CLI_TIMEOUT_MS = 12 * 60 * 60 * 1000;
/** Everything a tool WRITES must land under output/. */
const OUTPUT_DIR = 'output';
const READABLE_OUTPUT_EXT = ['.csv', '.jsonl', '.json', '.log', '.txt', '.md'] as const;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolSchema = Record<string, z.ZodTypeAny>;
type ToolHandler<Args> = (args: Args) => ToolResult | Promise<ToolResult>;
type ErasedMcpToolCallback = (args: Record<string, unknown>) => unknown;

interface ErasedMcpToolRegistrar {
  tool(name: string, description: string, inputSchema: ToolSchema, callback: ErasedMcpToolCallback): unknown;
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text: text || '(no output)' }] });
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function runCli(cliFile: string, argv: string[]): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', `src/cli/${cliFile}`, ...argv], {
      cwd: PG4_ROOT,
      maxBuffer: MAX_OUTPUT,
      timeout: CLI_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
    return ok(stdout || stderr);
  } catch (e: unknown) {
    const out = e as { stdout?: string; stderr?: string };
    return err(`ERROR: ${errorMessage(e)}\nSTDOUT: ${out.stdout || ''}\nSTDERR: ${out.stderr || ''}`);
  }
}

/**
 * Validate every agent-supplied path before it reaches a CLI: outputs must
 * land under output/, inputs anywhere in the repo except hidden paths
 * (`.env`, `.git`, …). Returns the violation as a tool error, or null.
 */
function checkPaths(paths: { outputs?: Array<string | undefined>; inputs?: Array<string | undefined> }): ToolResult | null {
  try {
    for (const p of paths.outputs ?? []) if (p !== undefined) resolveSandboxedPath(PG4_ROOT, OUTPUT_DIR, p);
    for (const p of paths.inputs ?? []) if (p !== undefined) resolveSandboxedPath(PG4_ROOT, '.', p);
    return null;
  } catch (e: unknown) {
    if (e instanceof SandboxViolation) return err(`Path rejected: ${e.message}`);
    throw e;
  }
}

const server = new McpServer({ name: 'pg4-mcp-server', version: '0.1.0' });
const toolRegistrar = server as unknown as ErasedMcpToolRegistrar;

/**
 * Keep the MCP SDK's expensive generic schema machinery at one deliberately
 * erased boundary. Runtime validation remains the exact schema supplied by
 * every caller; handler arguments stay explicit through `Args`.
 */
function registerTool<Args>(
  name: string,
  description: string,
  inputSchema: ToolSchema,
  handler: ToolHandler<Args>,
): void {
  toolRegistrar.tool(
    name,
    description,
    inputSchema,
    handler as unknown as ErasedMcpToolCallback,
  );
}

interface ScrapeToolArgs {
  out: string;
  category: string;
  province?: string;
  comuni?: string;
  region?: string;
  maps?: boolean;
  coverage?: 'default' | 'full';
  max_pages?: number;
}

interface EnrichToolArgs {
  input: string;
  out: string;
  enable_paid?: boolean;
  cost_ceiling_eur?: number;
  run_cost_ceiling_eur?: number;
  mock_http?: string;
}

interface RunToolArgs {
  category: string;
  out: string;
  province?: string;
  comuni?: string;
  region?: string;
  maps?: boolean;
  coverage?: 'default' | 'full';
  enable_paid?: boolean;
  cost_ceiling_eur?: number;
}

interface JudgeToolArgs {
  input: string;
  out: string;
  two_pass?: boolean;
  paid?: boolean;
  limit?: number;
  category?: string;
}

interface LookupToolArgs {
  piva?: string;
  phone?: string;
  dir?: string;
}

interface ListOutputsToolArgs {
  limit: number;
}

interface ReadOutputToolArgs {
  file_path: string;
  lines: number;
}

// --- ACTUATORS (the pipeline, one tool per CLI) ---

registerTool<ScrapeToolArgs>(
  'pg4_scrape',
  'Discover leads for a business category in a geographic scope (PagineGialle + optional Google Maps). Writes a raw CSV. Free by default.',
  {
    out: z.string().describe('Output CSV path, e.g. output/raw.csv'),
    category: z.string().describe('Business category, e.g. "agenzie immobiliari"'),
    province: z.string().optional().describe('Province code, e.g. PD (use this OR comuni)'),
    comuni: z.string().optional().describe('Comma-separated comuni (use this OR province)'),
    region: z.string().optional().describe('Region name'),
    maps: z.boolean().optional().describe('Also scrape Google Maps (default false, PG-only)'),
    coverage: z.enum(['default', 'full']).optional().describe('Maps query-variant coverage'),
    max_pages: z.number().optional().describe('Max result pages per source'),
  },
  async ({ out, category, province, comuni, region, maps, coverage, max_pages }) => {
    const bad = checkPaths({ outputs: [out] });
    if (bad) return bad;
    const argv = ['--out', out, '--category', category];
    pushFlag(argv, 'province', province);
    pushFlag(argv, 'comuni', comuni);
    pushFlag(argv, 'region', region);
    pushFlag(argv, 'maps', maps);
    pushFlag(argv, 'coverage', coverage);
    pushFlag(argv, 'max-pages', max_pages);
    return runCli('scrape.ts', argv);
  },
);

registerTool<EnrichToolArgs>(
  'pg4_enrich',
  'Enrich a raw CSV of leads (website, email, official company data, social). Free by default; paid providers stay off unless enable_paid is set.',
  {
    input: z.string().describe('Raw CSV input path'),
    out: z.string().describe('Enriched CSV output path'),
    enable_paid: z.boolean().optional().describe('Opt in to paid providers (needs env + keys). Default false.'),
    cost_ceiling_eur: z.number().optional().describe('Per-lead paid provider ceiling'),
    run_cost_ceiling_eur: z.number().optional().describe('Aggregate run ceiling for paid providers'),
    mock_http: z.string().optional().describe('Offline URL->HTML fixture JSON (no real HTTP/SERP/API)'),
  },
  async ({ input, out, enable_paid, cost_ceiling_eur, run_cost_ceiling_eur, mock_http }) => {
    const bad = checkPaths({ outputs: [out], inputs: [input, mock_http] });
    if (bad) return bad;
    const argv = ['--input', input, '--out', out];
    pushFlag(argv, 'enable-paid', enable_paid);
    pushFlag(argv, 'cost-ceiling-eur', cost_ceiling_eur);
    pushFlag(argv, 'run-cost-ceiling-eur', run_cost_ceiling_eur);
    pushFlag(argv, 'mock-http', mock_http);
    return runCli('enrich.ts', argv);
  },
);

registerTool<RunToolArgs>(
  'pg4_run',
  'End-to-end campaign: scrape + enrich in one run. Free by default.',
  {
    category: z.string().describe('Business category'),
    out: z.string().describe('Output base path, e.g. output/campaign'),
    province: z.string().optional().describe('Province code (use this OR comuni)'),
    comuni: z.string().optional().describe('Comma-separated comuni (use this OR province)'),
    region: z.string().optional().describe('Region name'),
    maps: z.boolean().optional().describe('Also scrape Google Maps'),
    coverage: z.enum(['default', 'full']).optional().describe('Maps query-variant coverage'),
    enable_paid: z.boolean().optional().describe('Opt in to paid providers. Default false.'),
    cost_ceiling_eur: z.number().optional().describe('Per-lead paid ceiling'),
  },
  async ({ category, out, province, comuni, region, maps, coverage, enable_paid, cost_ceiling_eur }) => {
    const bad = checkPaths({ outputs: [out] });
    if (bad) return bad;
    const argv = ['--category', category, '--out', out];
    pushFlag(argv, 'province', province);
    pushFlag(argv, 'comuni', comuni);
    pushFlag(argv, 'region', region);
    pushFlag(argv, 'maps', maps);
    pushFlag(argv, 'coverage', coverage);
    pushFlag(argv, 'enable-paid', enable_paid);
    pushFlag(argv, 'cost-ceiling-eur', cost_ceiling_eur);
    return runCli('run.ts', argv);
  },
);

registerTool<JudgeToolArgs>(
  'pg4_judge',
  'Two-axis judgment (A: silent-gem potential, B: website quality) over a CSV. Free at €0; paid enables LLM judges if keys are set.',
  {
    input: z.string().describe('CSV of companies'),
    out: z.string().describe('JSONL output path'),
    two_pass: z.boolean().optional().describe('§17 category-benchmark second pass'),
    paid: z.boolean().optional().describe('Enable LLM judges + paid sources'),
    limit: z.number().optional().describe('Cap number of rows judged'),
    category: z.string().optional().describe('Override category'),
  },
  async ({ input, out, two_pass, paid, limit, category }) => {
    const bad = checkPaths({ outputs: [out], inputs: [input] });
    if (bad) return bad;
    const argv = ['--input', input, '--out', out];
    pushFlag(argv, 'two-pass', two_pass);
    pushFlag(argv, 'paid', paid);
    pushFlag(argv, 'limit', limit);
    pushFlag(argv, 'category', category);
    return runCli('judge.ts', argv);
  },
);

registerTool<LookupToolArgs>(
  'pg4_lookup',
  'Find an already-scraped/enriched lead in the output folder by VAT (piva) or phone.',
  {
    piva: z.string().optional().describe('11-digit Partita IVA (piva OR phone required)'),
    phone: z.string().optional().describe('Phone number (piva OR phone required)'),
    dir: z.string().optional().describe('Directory to scan (default: output)'),
  },
  async ({ piva, phone, dir }) => {
    if (!piva && !phone) return err('Provide piva or phone.');
    const bad = checkPaths({ inputs: [dir] });
    if (bad) return bad;
    const argv: string[] = [];
    pushFlag(argv, 'piva', piva);
    pushFlag(argv, 'phone', phone);
    pushFlag(argv, 'dir', dir);
    return runCli('lookup.ts', argv);
  },
);

// --- SENSORS (read-only introspection) ---

registerTool<ListOutputsToolArgs>(
  'pg4_list_outputs',
  'List recent result files under the output/ folder (newest first).',
  { limit: z.number().default(40).describe('Max entries') },
  async ({ limit }) => {
    try {
      const dir = path.join(PG4_ROOT, 'output');
      if (!fs.existsSync(dir)) return ok('(no output/ folder yet)');
      const entries = fs
        .readdirSync(dir)
        .map((name) => {
          const st = fs.statSync(path.join(dir, name));
          return { name, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
        .map((e) => `${e.name}\t${e.size}B`);
      return ok(entries.join('\n'));
    } catch (e: unknown) {
      return err(`List error: ${errorMessage(e)}`);
    }
  },
);

registerTool<ReadOutputToolArgs>(
  'pg4_read_output',
  'Read the last N lines of a result file under output/ (csv/jsonl/json/log/txt/md). Path is sandboxed to output/.',
  {
    file_path: z.string().describe("Path relative to the repo root, e.g. 'output/enriched.csv'"),
    lines: z.number().int().min(1).max(100_000).default(50).describe('Lines to tail from the end'),
  },
  async ({ file_path, lines }) => {
    try {
      const abs = resolveSandboxedPath(PG4_ROOT, OUTPUT_DIR, file_path, { extensions: READABLE_OUTPUT_EXT });
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return err(`File not found: ${file_path}`);
      const { stdout } = await execFileAsync('tail', ['-n', String(lines), abs], { maxBuffer: MAX_OUTPUT });
      return ok(stdout);
    } catch (e: unknown) {
      if (e instanceof SandboxViolation) return err(`Path rejected: ${e.message}`);
      return err(`Read error: ${errorMessage(e)}`);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  onShutdownSignal('mcp', () => server.close());
  process.stderr.write('pg4 MCP server running on stdio\n');
}

// Only auto-start when run directly, so tests can import pushFlag without a server.
if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(`[mcp] fatal: ${errorMessage(e)}\n`);
    process.exit(1);
  });
}
