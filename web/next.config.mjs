/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dev API server runs separately (pnpm run serve, :8787). The client
  // reads NEXT_PUBLIC_API_BASE; default points at the local dev server.
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8787',
  },
};
export default nextConfig;
