import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `web/` is an independent pnpm project. Without this explicit root Next
  // picks the repository-level lockfile, which makes deployment tracing and
  // ESLint resolution depend on whichever parent project happens to exist.
  outputFileTracingRoot: appRoot,
  // Next 16 writes AGENTS.md + CLAUDE.md into web/ whenever `next dev` runs
  // under an AI coding agent. Contributor guidance lives in the repo root, so
  // the generated pair would only be untracked noise in every agent session.
  agentRules: false,
  // The dev-tools badge sits on the sidebar footer; the dashboard is shown in
  // demos straight from `next dev`.
  devIndicators: false,
  // The dev API server runs separately (pnpm run serve, :8787). The client
  // reads NEXT_PUBLIC_API_BASE; default points at the local dev server.
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8787',
    // Shown in the dashboard status bar.
    NEXT_PUBLIC_APP_VERSION: version,
  },
};
export default nextConfig;
