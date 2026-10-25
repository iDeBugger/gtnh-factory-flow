import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import { PROXY_BODY_MAX_BYTES } from "./body-limits.config";
import { securityHeaders } from "./security-headers.config";

const datasetBackendUrl = process.env.GTNH_DATASET_BACKEND_URL?.replace(/\/+$/, "");
/** A published dataset name's characters, never starting with a dot (route-pattern syntax). */
const PUBLISHED_SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
/** Any API path segment that does not start with a dot or a percent escape. */
const API_SEGMENT = "[^/.%][^/]*";

/**
 * The build's identity, baked into the server and browser bundles alike: the
 * dataset answers' cache key (`src/lib/datasets/answer-version.ts`), so two
 * builds that share an APP_VERSION never share a cached answer. The deploy
 * passes `GTNH_BUILD_ID` (`<version>-<sha8>`, the same value its image labels
 * and `/api/version` report; a build from `git archive` has no git to ask); a
 * checkout builds `<version>-<sha8>`, with `-dirty` for uncommitted changes.
 *
 * The version is read as text, never imported: `next start` loads this file
 * again at run time, and the site image ships only the src/ modules listed in
 * `next-config.test.ts`. Where neither the version nor git is there (that
 * run-time load) the value is unused: `env` is inlined at build.
 */
function buildIdentity(): string {
  const configured = process.env.GTNH_BUILD_ID?.trim();
  if (configured) {
    return configured;
  }
  const version = readAppVersion();
  const sha = git(["rev-parse", "--short=8", "HEAD"]);
  if (!sha) {
    return version;
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]) ? "-dirty" : "";
  return `${version}-${sha}${dirty}`;
}

function readAppVersion(): string {
  try {
    const source = readFileSync(path.join(process.cwd(), "src", "lib", "version.ts"), "utf8");
    return /APP_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1] ?? "";
  } catch {
    return "";
  }
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  // Always defined at build, so `process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY` is inlined in the browser AND the
  // server bundles as the build's value (unset at build inlines ""). The server then compares it with the
  // running process's (deployment-features.ts), and a build and a unit that disagree leave the routes off.
  env: {
    NEXT_PUBLIC_MOD_AND_COMMUNITY: process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY ?? "",
    NEXT_PUBLIC_GTNH_BUILD_ID: buildIdentity(),
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
    // Security headers first (security-headers.config.ts: the policy, framing, nosniff, referrer, HSTS, and
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
      // No segment forwarded to the backend can be `.` or `..`, plain or encoded: the version and every dataset
      // file segment are a published name's characters (dataset-path-gate.ts) and never start with a dot; an API
      // segment (a recipe id holds `:` and arrives encoded) never starts with a dot or `%`. Keep the backend an
      // instance of this app.
      beforeFiles: datasetBackendUrl
        ? [
            {
              source: `/api/datasets/:version(${PUBLISHED_SEGMENT})/:rest(${API_SEGMENT})*`,
              destination: `${datasetBackendUrl}/api/datasets/:version/:rest*`,
            },
            {
              source: `/datasets/gtnh/:version(${PUBLISHED_SEGMENT})/:rest(${PUBLISHED_SEGMENT})*`,
              destination: `${datasetBackendUrl}/datasets/gtnh/:version/:rest*`,
            },
          ]
        : [],
      afterFiles: appRewrites,
    };
  },
};

export default nextConfig;
