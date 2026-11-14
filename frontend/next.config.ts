import type { NextConfig } from "next";

// Live PRISM data comes from the FastAPI science server (server/). Two ways to reach it:
//  - NEXT_PUBLIC_PRISM_API_BASE: the browser calls that URL directly (CORS must allow the site);
//  - SPHEREX_API_INTERNAL_URL: Next proxies /api/* to it (default http://127.0.0.1:8000 locally).
// On Vercel with neither set, the build is static: no /api proxy, the explorer serves the
// labelled real snapshots in public/snapshots and says that live search needs the server.
const internalUrl = process.env.SPHEREX_API_INTERNAL_URL;
const backendUrl = (internalUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
const publicApi = process.env.NEXT_PUBLIC_PRISM_API_BASE || "";
const onVercel = Boolean(process.env.VERCEL);
const proxyEnabled = Boolean(internalUrl) || !onVercel;
const liveEnabled = Boolean(publicApi) || proxyEnabled;

const nextConfig: NextConfig = {
  // Vercel builds its own output; standalone is for the Docker image (compose.yaml).
  output: onVercel ? undefined : "standalone",
  experimental: {
    // Cold /v2/spectrum and /v2/verdict take ~20-60 s (real IRSA downloads); the proxy
    // default of 30 s would cut them off.
    proxyTimeout: 180_000,
  },
  env: {
    NEXT_PUBLIC_USE_REAL_API: process.env.NEXT_PUBLIC_USE_REAL_API || 'true',
    NEXT_PUBLIC_PRISM_LIVE: process.env.NEXT_PUBLIC_PRISM_LIVE || (liveEnabled ? '1' : '0'),
  },
  async rewrites() {
    if (!proxyEnabled) return [];
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
