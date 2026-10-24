import type { NextConfig } from "next";

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
  async headers() {
    return [
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

    if (!datasetBackendUrl) {
      return appRewrites;
    }

    return {
      beforeFiles: [
        {
          source: "/api/datasets/:path*",
          destination: `${datasetBackendUrl}/api/datasets/:path*`,
        },
        {
          source: "/datasets/gtnh/:path*",
          destination: `${datasetBackendUrl}/datasets/gtnh/:path*`,
        },
      ],
      afterFiles: appRewrites,
    };
  },
};

export default nextConfig;
