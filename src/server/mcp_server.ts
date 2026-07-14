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
 * The MCP SDK used to make this file impractical to typecheck. Current SDK and
 * TypeScript versions compile it under the normal root `tsconfig`, so CI covers
 * the stdio bridge as well as `mcp_args.ts`. The latter remains a small pure
 * helper for argument-policy tests.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { pushFlag } from './mcp_args';

const execFileAsync = promisify(execFile);
const PG4_ROOT = path.resolve(__dirname, '..', '..'); // src/server -> pg4/
const MAX_OUTPUT = 32 * 1024 * 1024;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text: text || '(no output)' }] });
const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

async function runCli(cliFile: string, argv: string[]): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', `src/cli/${cliFile}`, ...argv], {
      cwd: PG4_ROOT,
      maxBuffer: MAX_OUTPUT,
    });
    return ok(stdout || stderr);
  } catch (e: any) {
    return err(`ERROR: ${e.message}\nSTDOUT: ${e.stdout || ''}\nSTDERR: ${e.stderr || ''}`);
  }
}

const server = new McpServer({ name: 'pg4-mcp-server', version: '0.1.0' });

// --- ACTUATORS (the pipeline, one tool per CLI) ---

server.tool(
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

server.tool(
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
    const argv = ['--input', input, '--out', out];
    pushFlag(argv, 'enable-paid', enable_paid);
    pushFlag(argv, 'cost-ceiling-eur', cost_ceiling_eur);
    pushFlag(argv, 'run-cost-ceiling-eur', run_cost_ceiling_eur);
    pushFlag(argv, 'mock-http', mock_http);
    return runCli('enrich.ts', argv);
  },
);

server.tool(
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

server.tool(
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
    const argv = ['--input', input, '--out', out];
    pushFlag(argv, 'two-pass', two_pass);
    pushFlag(argv, 'paid', paid);
    pushFlag(argv, 'limit', limit);
    pushFlag(argv, 'category', category);
    return runCli('judge.ts', argv);
  },
);

server.tool(
  'pg4_lookup',
  'Find an already-scraped/enriched lead in the output folder by VAT (piva) or phone.',
  {
    piva: z.string().optional().describe('11-digit Partita IVA (piva OR phone required)'),
    phone: z.string().optional().describe('Phone number (piva OR phone required)'),
    dir: z.string().optional().describe('Directory to scan (default: output)'),
  },
  async ({ piva, phone, dir }) => {
    if (!piva && !phone) return err('Provide piva or phone.');
    const argv: string[] = [];
    pushFlag(argv, 'piva', piva);
    pushFlag(argv, 'phone', phone);
    pushFlag(argv, 'dir', dir);
    return runCli('lookup.ts', argv);
  },
);

// --- SENSORS (read-only introspection) ---

server.tool(
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
    } catch (e: any) {
      return err(`List error: ${e.message}`);
    }
  },
);

server.tool(
  'pg4_read_output',
  'Read the last N lines of a result file under output/ (csv/jsonl/log). Path is sandboxed to pg4/.',
  {
    file_path: z.string().describe("Path relative to pg4/, e.g. 'output/enriched.csv'"),
    lines: z.number().default(50).describe('Lines to tail from the end'),
  },
  async ({ file_path, lines }) => {
    try {
      const abs = path.resolve(PG4_ROOT, file_path);
      if (abs !== PG4_ROOT && !abs.startsWith(PG4_ROOT + path.sep)) {
        return err('Path traversal is forbidden.');
      }
      if (!fs.existsSync(abs)) return err(`File not found: ${file_path}`);
      const { stdout } = await execFileAsync('tail', ['-n', String(lines), abs], { maxBuffer: MAX_OUTPUT });
      return ok(stdout);
    } catch (e: any) {
      return err(`Read error: ${e.message}`);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('pg4 MCP server running on stdio');
}

// Only auto-start when run directly, so tests can import pushFlag without a server.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
