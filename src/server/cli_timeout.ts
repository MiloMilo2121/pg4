/**
 * Longest a server-started CLI run (MCP tool or dashboard scrape job) may take
 * before it is killed. A full province with Maps takes hours, so the bound is
 * generous: it only stops a hung pipeline from running forever. One constant,
 * so the dashboard cannot again kill at 10 minutes a run the MCP lets finish.
 */
export const CLI_RUN_TIMEOUT_MS = 12 * 60 * 60 * 1000;
