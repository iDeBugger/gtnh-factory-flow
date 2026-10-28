import type { NextConfig } from "next";
import { PROXY_BODY_MAX_BYTES } from "./body-limits.config";
import { securityHeaders } from "./security-headers.config";
import { buildIdentity } from "./tools/build/build-identity.mjs";

const datasetBackendUrl = process.env.GTNH_DATASET_BACKEND_URL?.replace(/\/+$/, "");
/** A published dataset name's characters, never starting with a dot (route-pattern syntax). */
const PUBLISHED_SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]*";
/** Any API path segment that does not start with a dot or a percent escape. */
const API_SEGMENT = "[^/.%][^/]*";

const nextConfig: NextConfig = {
  // Always defined at build, so `process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY` is inlined in the browser AND the
  // server bundles as the build's value (unset at build inlines ""). The server then compares it with the
  // running process's (deployment-features.ts), and a build and a unit that disagree leave the routes off.
  env: {
    NEXT_PUBLIC_MOD_AND_COMMUNITY: process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY ?? "",
    // The dataset answers' cache key (tools/build/build-identity.mjs). The site image's standalone
    // `server.js` reads no config file: it carries this one, serialized at build, so the value is fixed then.
    NEXT_PUBLIC_GTNH_BUILD_ID: buildIdentity(),
  },
  // The site image runs `.next/standalone/server.js`: the traced server files and only the packages they
  // load, so a deploy whose lockfile is unchanged copies no node_modules. Its config is this one, serialized
  // at build into the server (required-server-files.json); nothing reads next.config.ts at run time.
  output: "standalone",
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
    // A revalidated page (the sitemap, llms.txt: `revalidate = 3600`) is kept in memory only. The site
    // image's .next is read-only, so a write back under .next/server would fail on every revalidation;
    // the prerendered files are still read from disk at start.
    isrFlushToDisk: false,
  },
  async headers() {
    // The headers are read at build into the routes manifest, which is also when NEXT_PUBLIC_* is fixed.
    // Security headers (security-headers.config.ts: the policy, framing, nosniff, referrer, HSTS, and the
    // solver worker's own policy on the static chunks). No cache rule by path for the datasets: a rule here
    // beats the answer's own header, so a missing texture would be kept a year like a file. The
    // dataset-files route sets each answer's policy (content-named textures immutable, a miss no-store).
    return [
      ...securityHeaders({
        production: process.env.NODE_ENV === "production",
        liveUrl: process.env.NEXT_PUBLIC_LIVE_URL,
        siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
        modAndCommunity: process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY,
      }),
    ];
  },
  async rewrites() {
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
            // src/proxy.ts has already sent the content-named textures to the dataset-files route.
            {
              source: `/dataset-files/:version(${PUBLISHED_SEGMENT})/textures/:root(rendered|icons)/:file(${PUBLISHED_SEGMENT})`,
              destination: `${datasetBackendUrl}/datasets/gtnh/:version/textures/:root/:file`,
            },
          ]
        : [],
      afterFiles: [],
    };
  },
};

export default nextConfig;
