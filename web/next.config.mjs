import { fileURLToPath } from 'url';

const appRoot = fileURLToPath(new URL('.', import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `web/` is an independent pnpm project. Without this explicit root Next
  // picks the repository-level lockfile, which makes deployment tracing and
  // ESLint resolution depend on whichever parent project happens to exist.
  outputFileTracingRoot: appRoot,
  // The dev API server runs separately (pnpm run serve, :8787). The client
  // reads NEXT_PUBLIC_API_BASE; default points at the local dev server.
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8787',
  },
};
export default nextConfig;
