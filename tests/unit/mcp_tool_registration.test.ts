import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Boots the real MCP server as a child process and talks to it over stdio.
 *
 * Unit tests import the server module in-process, so nothing covers the
 * registration path end to end. A server that starts, answers `initialize`
 * and then advertises zero tools looks perfectly healthy from the outside —
 * an agent just quietly finds it has no capabilities.
 *
 * This is a guard, not a bug reproduction: the SDK still implements the
 * deprecated `tool()` overload, so the test also passed against it. Its value
 * is that an SDK major removing `tool()` fails here with a readable message.
 */
const REPO_ROOT = path.resolve(__dirname, '../..');

describe('MCP server advertises its tools over stdio', () => {
  it('lists every tool the server registers', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-r', 'tsx/cjs', 'src/server/mcp_server.ts'],
      cwd: REPO_ROOT,
      env: { ...process.env, LOG_FORMAT: 'json' } as Record<string, string>,
      stderr: 'pipe',
    });

    const client = new Client({ name: 'pg4-test-client', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      // Every tool is a thin wrapper over a real CLI, so a missing one means an
      // agent silently loses that capability. Names carry the `pg4_` prefix to
      // avoid colliding with whatever else the host agent has connected.
      expect(names).toEqual([
        'pg4_enrich',
        'pg4_judge',
        'pg4_list_outputs',
        'pg4_lookup',
        'pg4_read_output',
        'pg4_run',
        'pg4_scrape',
      ]);

      // Descriptions and input schemas are what the client model reasons over;
      // an empty description makes a tool effectively invisible to an agent.
      for (const tool of tools) {
        expect(tool.description, `${tool.name} has no description`).toBeTruthy();
        expect(tool.inputSchema, `${tool.name} has no input schema`).toBeTruthy();
      }
    } finally {
      await client.close();
    }
  }, 30_000);
});
