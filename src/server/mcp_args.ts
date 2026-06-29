/**
 * Pure arg-building helper for the MCP server. SDK-free on purpose: the
 * @modelcontextprotocol/sdk types are pathological for `tsc` (TS2589), so
 * mcp_server.ts is excluded from the project typecheck — this module keeps the
 * only non-trivial logic typechecked + unit-tested.
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
