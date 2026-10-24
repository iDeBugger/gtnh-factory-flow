import type { NextConfig } from "next";

const datasetBackendUrl = process.env.GTNH_DATASET_BACKEND_URL?.replace(/\/+$/, "");

/**
 * Dataset gzips and shards are replaced in place on a republish, under the same
 * names (only textures are content-named), so a day at the edge and in a
 * browser, never `immutable`. Nothing in the app fetches them: they are read
 * from disk by the server. Not the manifest, which the client reads on load and
 * which must show a publish at once.
 */
const DATASET_FILE_CACHE_CONTROL = "public, max-age=86400";

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
  async headers() {
    return [
      {
        // Browsers that have seen the site over TLS keep asking for it that way for six months, so a pasted
        // http:// link or a captive portal never carries the session cookie in the clear. Cloudflare passes
        // origin headers through. No includeSubDomains: a staging subdomain may not be TLS.
        source: "/:path*",
        headers: [{ key: "Strict-Transport-Security", value: "max-age=15552000" }],
      },
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
      {
        source: "/datasets/gtnh/:version/recipes-shards/:file",
        headers: [{ key: "Cache-Control", value: DATASET_FILE_CACHE_CONTROL }],
      },
      {
        source:
          "/datasets/gtnh/:version/:file(recipes\\.json\\.gz|recipe-index\\.json\\.gz|recipe-lookup-index\\.json\\.gz|resource-index\\.json\\.gz)",
        headers: [{ key: "Cache-Control", value: DATASET_FILE_CACHE_CONTROL }],
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

    return {
      beforeFiles: [
        // Next serves everything under public/datasets/gtnh itself, before any
        // route, and the raw recipes.json is about 2 GB per download. Only a
        // rewrite here runs before the public files: the target exists on no
        // disk, so the request reaches the [assetFile] route, which refuses
        // it. Every rule here runs in order on the already rewritten path, so
        // with the dataset proxy below set the renamed path is forwarded and
        // the backend's own route refuses it; the block must stay first.
        {
          source: "/datasets/gtnh/:version/recipes.json",
          destination: "/datasets/gtnh/:version/recipes.json.raw",
        },
        ...(datasetBackendUrl
          ? [
              {
                source: "/api/datasets/:path*",
                destination: `${datasetBackendUrl}/api/datasets/:path*`,
              },
              {
                source: "/datasets/gtnh/:path*",
                destination: `${datasetBackendUrl}/datasets/gtnh/:path*`,
              },
            ]
          : []),
      ],
      afterFiles: appRewrites,
    };
  },
};

export default nextConfig;
