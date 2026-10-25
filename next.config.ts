import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";
import { PROXY_BODY_MAX_BYTES } from "./src/lib/server/request-body";

const datasetBackendUrl = process.env.GTNH_DATASET_BACKEND_URL?.replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // Always defined at build, so `process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY` is inlined in the browser AND the
  // server bundles as the build's value (unset at build inlines ""). The server then compares it with the
  // running process's (deployment-features.ts), and a build and a unit that disagree leave the routes off.
  env: {
    NEXT_PUBLIC_MOD_AND_COMMUNITY: process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY ?? "",
  },
  outputFileTracingRoot: process.cwd(),
  turbopack: {
    root: process.cwd(),
  },
  // The site never uses next/image: pictures are served by the app's own routes or plain <img>.
  // With the optimizer off, /_next/image answers 404 and no upload or dataset PNG reaches sharp.
  images: { unoptimized: true },
  // The framework's own X-Powered-By names the server software for nothing.
  poweredByHeader: false,
  experimental: {
    // src/proxy.ts runs on every path, so Next holds each write body up to this size before a route runs
    // (default 10 MB). Just above the largest route cap, never below one (request-body.ts).
    proxyClientMaxBodySize: PROXY_BODY_MAX_BYTES,
  },
  async headers() {
    // The headers are read at build into the routes manifest, which is also when NEXT_PUBLIC_* is fixed.
    // Security headers first (src/lib/security-headers.ts: the policy, framing, nosniff, referrer, HSTS, and
    // the solver worker's own policy on the static chunks), then the texture cache rules.
    return [
      ...securityHeaders({
        production: process.env.NODE_ENV === "production",
        liveUrl: process.env.NEXT_PUBLIC_LIVE_URL,
      }),
      {
        source: "/datasets/gtnh/:version/textures/icons/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // Rendered item, block and fluid icons are named by a hash of their
        // bytes (the normalizer's staging, stage-rendered-icons.mjs, and the
        // fluid alpha pass for what it repaints), so changed pixels get a new
        // URL and these can be immutable too. They are most of what a
        // returning browser re-downloads.
        source: "/datasets/gtnh/:version/textures/rendered/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  async rewrites() {
    const appRewrites = [
      {
        source: "/umami",
        destination: "http://127.0.0.1:8582/umami",
      },
      {
        source: "/umami/:path*",
        destination: "http://127.0.0.1:8582/umami/:path*",
      },
      {
        source: "/_umami/:path*",
        destination: "http://127.0.0.1:8582/umami/:path*",
      },
    ];

    // Dataset data files are not gated here: a rewrite matches the path as
    // sent and is bypassed by percent-encoding. src/proxy.ts does that on the
    // decoded path; it runs before these rules, so the dev proxy below never
    // sees the gzips, the shards or recipes.json.
    return {
      // The version segment holds only the characters a published name may (dataset-path-gate.ts), so an
      // encoded `..%2f` in it is never forwarded to the backend; keep the backend an instance of this app.
      beforeFiles: datasetBackendUrl
        ? [
            {
              source: "/api/datasets/:version([A-Za-z0-9._-]+)/:rest*",
              destination: `${datasetBackendUrl}/api/datasets/:version/:rest*`,
            },
            {
              source: "/datasets/gtnh/:version([A-Za-z0-9._-]+)/:rest*",
              destination: `${datasetBackendUrl}/datasets/gtnh/:version/:rest*`,
            },
          ]
        : [],
      afterFiles: appRewrites,
    };
  },
};

export default nextConfig;
