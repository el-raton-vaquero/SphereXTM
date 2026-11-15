import type { NextConfig } from "next";

// Live Listar data comes from the FastAPI science server (server/). Two ways to reach it:
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
    NEXT_PUBLIC_PRISM_LIVE: process.env.NEXT_PUBLIC_PRISM_LIVE || (liveEnabled ? '1' : '0'),
  },
  // Old routes. Redirects keep the query string (target, ra, dec, lang...) and run on Vercel
  // (static or not) and in the standalone Docker server alike.
  async redirects() {
    return [
      { source: '/prism', destination: '/explore', permanent: false },
      { source: '/prism/:path*', destination: '/explore', permanent: false },
      { source: '/classic', destination: '/explore', permanent: false },
      { source: '/classic/:path*', destination: '/explore', permanent: false },
      { source: '/cosmos', destination: '/', permanent: false },
      // The old standalone cube demo; the 3D cube lives in the explorer's "3D cube" view.
      // Only this route: public/cosmos/* (textures, star catalogue) must stay reachable.
      { source: '/cosmos/cube', destination: '/explore', permanent: false },
      { source: '/cosmos/cube/:path*', destination: '/explore', permanent: false },
    ];
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
