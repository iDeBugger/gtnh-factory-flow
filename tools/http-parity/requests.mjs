/**
 * The wire-format parity cases: every request the harness sends, in order.
 *
 * `CASES` runs first, then `SCENARIO`, on a fresh database, so every row the
 * answers name is made by the run itself in the same order (the normalizer
 * numbers ids by first appearance). A case may `save` a value from its answer
 * (`{ from: "json", path }`, `{ from: "header", name }` or
 * `{ from: "cookie", name }`, kept `as` a name), and a later target or header
 * value names it as `{name}`, or `{name|uri}` for a path segment; a body
 * that needs one is a function of the saved values.
 * The capture fills `{hash:<version>}` (each dataset's checksum, from the
 * served manifest) and `{build}` (from `/api/version`) before the first case.
 *
 * Addresses: a case that reaches a per-address limit sends its own
 * `X-Client-Ip` (documentation ranges, one per group), so no group spends
 * another's count. Dataset cases send none: the dataset budget never refuses
 * a request without an address, and a budget measured in milliseconds would
 * make the answers depend on timing.
 *
 * `modes` names the community switch values a case runs in; `localOnly`
 * cases (raw spellings, no Host) are skipped against stage, where Caddy
 * rewrites them first; `nextOnly` cases hit the throw and escape fixtures
 * that exist only in the Next baseline build (Task 0), and the allow list
 * names them.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { harnessGateCases } from "../../src/test-support/dataset-gate-cases.ts";

export const VERSIONS = ["local-2.9.0-rc-2", "local-2.8.1"];
const V0 = VERSIONS[0];

/** Whether a version has crop-farm recipes: 2.8.1 has none, so there is no crop id to look up. */
const HAS_CROPS = { "local-2.9.0-rc-2": true, "local-2.8.1": false };

/** One content-named texture that exists in each version. */
const RENDERED_TEXTURE = {
  "local-2.9.0-rc-2": "0_wall_marking-70819c300142.png",
  "local-2.8.1": "0lafe_a_nerf_dog-1a1ef9427fff.png",
};

const BOTH = ["off", "on"];
const ON = ["on"];
const MISSING_UUID = "00000000-0000-4000-8000-000000000000";
const JSON_TYPE = { "Content-Type": "application/json" };
const PASSWORD = "parity-password-0001";
const STAMP = "2026-10-27T10:00:00.000Z";

const fixturePlan = JSON.parse(
  readFileSync(
    new URL("../../src/lib/solver/__fixtures__/pa-cell-loop-plan.json", import.meta.url),
    "utf8",
  ),
);

function pngBytes(width, height) {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 30;
    png.data[index + 1] = 160;
    png.data[index + 2] = 220;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

const BOUNDARY = "----parity-boundary-7f3a9c";
const MULTIPART_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

function multipart(field, filename, type, bytes) {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

const SMALL_PNG = pngBytes(8, 6);
const IMAGE_FORM = multipart("image", "board.png", "image/png", SMALL_PNG);
const NO_IMAGE_FORM = multipart("other", "board.png", "image/png", SMALL_PNG);
/** A PNG header and filler past the 4 MB picture cap: the route refuses it before it decodes anything. */
const BIG_IMAGE_FORM = multipart(
  "image",
  "big.png",
  "image/png",
  Buffer.concat([SMALL_PNG.subarray(0, 33), Buffer.alloc(6 * 1024 * 1024 - 33, 0x41)]),
);
const BIG_LOGIN = JSON.stringify({ username: "parity-big", password: "a".repeat(17 * 1024) });

const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) search.append(key, String(entry));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

const designBody = (name) =>
  JSON.stringify({
    name,
    icon: null,
    folderId: "parity-folder-1",
    closed: false,
    favorite: false,
    order: 1,
    communityPlanId: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    planUpdatedAt: STAMP,
    plan: { ...fixturePlan, id: "parity-design-plan", name },
  });

const blueprintBody = JSON.stringify({
  name: "Parity blueprint",
  payload: {
    nodes: fixturePlan.nodes,
    storages: fixturePlan.storages ?? [],
    annotations: fixturePlan.annotations ?? [],
    pockets: fixturePlan.pockets ?? [],
    edges: fixturePlan.edges,
    recipes: fixturePlan.recipes,
  },
  tags: ["parity"],
});

const publishBody = JSON.stringify({
  name: "Parity plan",
  description: "A plan for the parity run.",
  gameVersion: "2.9.0",
  datasetVersionId: V0,
  plan: { ...fixturePlan, id: "parity-community-plan", name: "Parity plan" },
  tags: ["parity"],
  isPublic: true,
});

// ---------------------------------------------------------------------------
// The route table: every route file, its exported methods, a valid and an invalid input for each.

/**
 * `route` is the Next path with its brackets (`[planId]`), `path` a concrete
 * spelling of it. Each method lists `[label, input]` pairs: the input is a
 * target suffix, headers and a body.
 */
const ROUTES = [
  {
    route: "/api/accounts/search",
    path: "/api/accounts/search",
    methods: {
      GET: [
        ["valid", { suffix: "?q=pa" }],
        ["invalid", { suffix: "" }],
      ],
    },
  },
  {
    route: "/api/blueprints",
    path: "/api/blueprints",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { suffix: "?scope=public" }],
      ],
      POST: [
        ["valid", { body: blueprintBody, headers: JSON_TYPE }],
        ["invalid", { body: "not json", headers: JSON_TYPE }],
      ],
    },
  },
  {
    route: "/api/blueprints/[blueprintId]",
    path: `/api/blueprints/${MISSING_UUID}`,
    invalidPath: "/api/blueprints/not-an-id",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
      PUT: [
        ["valid", { body: blueprintBody, headers: JSON_TYPE }],
        ["invalid", { invalidPath: true, body: "{}" }],
      ],
      DELETE: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/community/auth/login",
    path: "/api/community/auth/login",
    methods: {
      POST: [
        [
          "valid",
          {
            body: JSON.stringify({ username: "parity-nobody", password: PASSWORD }),
            headers: JSON_TYPE,
          },
        ],
        ["invalid", { body: "not json", headers: JSON_TYPE }],
      ],
    },
  },
  {
    route: "/api/community/auth/logout",
    path: "/api/community/auth/logout",
    methods: {
      POST: [
        ["valid", { body: "{}", headers: JSON_TYPE }],
        ["invalid", { body: "not json", headers: JSON_TYPE }],
        [
          "everywhere signed out",
          { body: JSON.stringify({ everywhere: true }), headers: JSON_TYPE },
        ],
      ],
    },
  },
  {
    route: "/api/community/auth/me",
    path: "/api/community/auth/me",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { headers: { Cookie: "gtnh_session=garbage" } }],
      ],
    },
  },
  {
    route: "/api/community/auth/register",
    path: "/api/community/auth/register",
    methods: {
      POST: [
        [
          "valid",
          {
            body: JSON.stringify({ username: "parity-case", password: PASSWORD }),
            headers: { ...JSON_TYPE, "X-Client-Ip": "192.0.2.1" },
          },
        ],
        [
          "invalid",
          {
            body: JSON.stringify({ username: "x" }),
            headers: { ...JSON_TYPE, "X-Client-Ip": "192.0.2.1" },
          },
        ],
      ],
    },
  },
  {
    route: "/api/community/images/[month]/[name]",
    path: "/api/community/images/2026-10/0123456789abcdef01.png",
    invalidPath: "/api/community/images/2026-10/x.exe",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/community/images",
    path: "/api/community/images",
    methods: {
      POST: [
        [
          "valid",
          {
            body: IMAGE_FORM,
            headers: { "Content-Type": MULTIPART_TYPE, "X-Client-Ip": "192.0.2.2" },
          },
        ],
        [
          "invalid",
          {
            body: NO_IMAGE_FORM,
            headers: { "Content-Type": MULTIPART_TYPE, "X-Client-Ip": "192.0.2.2" },
          },
        ],
      ],
    },
  },
  {
    route: "/api/community/plans/[planId]/comments/[commentId]",
    path: `/api/community/plans/${MISSING_UUID}/comments/${MISSING_UUID}`,
    invalidPath: "/api/community/plans/not-an-id/comments/not-an-id",
    methods: {
      DELETE: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/community/plans/[planId]/comments",
    path: `/api/community/plans/${MISSING_UUID}/comments`,
    invalidPath: "/api/community/plans/not-an-id/comments",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
      POST: [
        ["valid", { body: JSON.stringify({ body: "Hello." }), headers: JSON_TYPE }],
        ["invalid", { body: "not json", headers: JSON_TYPE }],
      ],
    },
  },
  {
    route: "/api/community/plans/[planId]/download",
    path: `/api/community/plans/${MISSING_UUID}/download`,
    invalidPath: "/api/community/plans/not-an-id/download",
    methods: {
      POST: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/community/plans/[planId]/preview",
    path: `/api/community/plans/${MISSING_UUID}/preview`,
    invalidPath: "/api/community/plans/not-an-id/preview",
    methods: {
      POST: [
        ["valid", { body: IMAGE_FORM, headers: { "Content-Type": MULTIPART_TYPE } }],
        ["invalid", { invalidPath: true, body: "x" }],
      ],
      GET: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/community/plans/[planId]",
    path: `/api/community/plans/${MISSING_UUID}`,
    invalidPath: "/api/community/plans/not-an-id",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
      PUT: [
        ["valid", { body: publishBody, headers: JSON_TYPE }],
        ["invalid", { body: "not json", headers: JSON_TYPE }],
      ],
      DELETE: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/community/plans/[planId]/view",
    path: `/api/community/plans/${MISSING_UUID}/view`,
    invalidPath: "/api/community/plans/not-an-id/view",
    methods: {
      POST: [
        ["valid", { headers: { "X-Client-Ip": "192.0.2.3" } }],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/community/plans/[planId]/vote",
    path: `/api/community/plans/${MISSING_UUID}/vote`,
    methods: {
      POST: [
        [
          "valid",
          {
            body: JSON.stringify({ deviceId: "parity-device", value: 1 }),
            headers: { ...JSON_TYPE, "X-Client-Ip": "192.0.2.4" },
          },
        ],
        ["invalid", { body: JSON.stringify({ value: 2 }), headers: JSON_TYPE }],
      ],
    },
  },
  {
    route: "/api/community/plans",
    path: "/api/community/plans",
    methods: {
      GET: [
        ["valid", { suffix: "?sort=new" }],
        ["invalid", { suffix: "?page=-3&pageSize=x&sort=bogus" }],
      ],
      POST: [
        ["valid", { body: publishBody, headers: JSON_TYPE }],
        ["invalid", { body: "not json", headers: JSON_TYPE }],
      ],
    },
  },
  ...["catalog", "client-files", "crops", "mobs", "prewarm", "recipe-ids", "resources"].map(
    (name) => ({
      route: `/api/datasets/[versionId]/${name}`,
      path: `/api/datasets/${V0}/${name}`,
      invalidPath: `/api/datasets/no-such-version/${name}`,
      methods: {
        GET: [
          ["valid", {}],
          ["invalid", { invalidPath: true }],
        ],
      },
    }),
  ),
  {
    route: "/api/datasets/[versionId]/recipes/[recipeId]",
    path: `/api/datasets/${V0}/recipes/no-such-recipe`,
    invalidPath: "/api/datasets/no-such-version/recipes/x",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/datasets/[versionId]/recipes",
    path: `/api/datasets/${V0}/recipes`,
    invalidPath: "/api/datasets/no-such-version/recipes",
    methods: {
      GET: [
        ["valid", { suffix: "?query=steel" }],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/datasets/[versionId]/resolve-recipes",
    path: `/api/datasets/${V0}/resolve-recipes`,
    methods: {
      POST: [
        ["valid", { body: JSON.stringify({ recipes: [] }), headers: JSON_TYPE }],
        ["invalid", { body: JSON.stringify({ recipes: "x" }), headers: JSON_TYPE }],
      ],
    },
  },
  {
    route: "/api/highs/[file]",
    path: "/api/highs/highs.js",
    invalidPath: "/api/highs/constructor",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/library/designs/[designId]/members/[userId]",
    path: `/api/library/designs/parity-design-0/members/${MISSING_UUID}`,
    invalidPath: "/api/library/designs/x/members/y",
    methods: {
      PUT: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
      DELETE: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/library/designs/[designId]/members",
    path: "/api/library/designs/parity-design-0/members",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { suffix: "?owner=not-an-id" }],
      ],
    },
  },
  {
    route: "/api/library/designs/[designId]",
    path: "/api/library/designs/parity-design-0",
    invalidPath: "/api/library/designs/x",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { suffix: "?owner=not-an-id" }],
      ],
      PUT: [
        ["valid", { body: designBody("Case design"), headers: JSON_TYPE }],
        ["invalid", { invalidPath: true, body: "{}" }],
      ],
      DELETE: [
        ["valid", {}],
        ["invalid", { suffix: "?owner=not-an-id" }],
      ],
    },
  },
  {
    route: "/api/library/folders/[folderId]",
    path: "/api/library/folders/parity-folder-0",
    invalidPath: "/api/library/folders/x",
    methods: {
      PUT: [
        [
          "valid",
          {
            body: JSON.stringify({ name: "F", createdAt: STAMP, updatedAt: STAMP }),
            headers: JSON_TYPE,
          },
        ],
        ["invalid", { invalidPath: true, body: "{}" }],
      ],
      DELETE: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/api/library",
    path: "/api/library",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { suffix: "?x=1" }],
      ],
    },
  },
  {
    route: "/api/resource-popularity",
    path: "/api/resource-popularity",
    methods: {
      GET: [
        ["valid", {}],
        ["count", { suffix: "?count=1" }],
      ],
    },
  },
  {
    route: "/api/version",
    path: "/api/version",
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { suffix: "?x=%zz" }],
      ],
    },
  },
  {
    route: "/dataset-files/[versionId]/[...assetPath]",
    path: `/dataset-files/${V0}/recipe-lookup-index.json.gz`,
    invalidPath: `/dataset-files/${V0}/notes.txt`,
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
  {
    route: "/datasets/gtnh/[versionId]/textures/[...assetPath]",
    path: `/datasets/gtnh/${V0}/textures/atlas/atlas-0000.png`,
    invalidPath: `/datasets/gtnh/${V0}/textures/other/x.png`,
    methods: {
      GET: [
        ["valid", {}],
        ["invalid", { invalidPath: true }],
      ],
    },
  },
];

export const ROUTE_TABLE = ROUTES.map(({ route, path, methods }) => ({
  route,
  path,
  methods: Object.keys(methods),
}));

const cases = [];
const add = (entry) => cases.push({ modes: BOTH, ...entry });

for (const spec of ROUTES) {
  for (const [method, inputs] of Object.entries(spec.methods)) {
    for (const [label, input] of inputs) {
      const base = input.invalidPath ? spec.invalidPath : spec.path;
      add({
        name: `route ${method} ${spec.route} ${label}`,
        route: spec.route,
        method,
        target: `${base}${input.suffix ?? ""}`,
        headers: input.headers,
        body: input.body,
      });
    }
  }
  add({
    name: `route PATCH ${spec.route} unexported`,
    route: spec.route,
    method: "PATCH",
    target: spec.path,
  });
  add({ name: `route HEAD ${spec.route}`, route: spec.route, method: "HEAD", target: spec.path });
  add({
    name: `route OPTIONS ${spec.route}`,
    route: spec.route,
    method: "OPTIONS",
    target: spec.path,
  });
}

// llms.txt is a site file, answered from memory ahead of the routes, but keeps the route case names and methods
// it was captured under.
for (const [name, method, target] of [
  ["route GET /llms.txt valid", "GET", "/llms.txt"],
  ["route GET /llms.txt invalid", "GET", "/llms.txt?x=1"],
  ["route PATCH /llms.txt unexported", "PATCH", "/llms.txt"],
  ["route HEAD /llms.txt", "HEAD", "/llms.txt"],
  ["route OPTIONS /llms.txt", "OPTIONS", "/llms.txt"],
]) {
  add({ name, method, target });
}

// Pages and site files.
for (const target of ["/", "/?plan=missing", "/community", "/community?plan=x", "/no-such-page"]) {
  add({ name: `page ${target}`, method: "GET", target });
}
for (const target of [
  "/sitemap.xml",
  "/robots.txt",
  "/manifest.webmanifest",
  "/llms.txt",
  "/favicon.ico",
  "/opengraph-image.png",
  "/dev/clean-card",
  "/_next/image?url=/icon-192.png&w=64&q=75",
]) {
  add({ name: `site ${target}`, method: "GET", target });
}

// Public files.
add({
  name: "public /icon-192.png",
  method: "GET",
  target: "/icon-192.png",
  save: [{ from: "header", name: "etag", as: "etag:icon" }],
});
add({
  name: "public /icon-192.png If-None-Match",
  method: "GET",
  target: "/icon-192.png",
  headers: { "If-None-Match": "{etag:icon}" },
});
for (const target of [
  "/highs.wasm",
  "/highs.js",
  "/apple-touch-icon.png",
  "/api/highs/highs.wasm",
]) {
  add({ name: `public ${target}`, method: "GET", target });
}
add({ name: "manifest", method: "GET", target: "/datasets/gtnh/datasets.manifest.json" });

// HEAD and OPTIONS outside the route files: the page, a public file, a dataset file and a texture.
for (const target of [
  "/",
  "/icon-192.png",
  `/datasets/gtnh/${V0}/recipe-lookup-index.json.gz`,
  `/datasets/gtnh/${V0}/textures/rendered/${RENDERED_TEXTURE[V0]}`,
]) {
  for (const method of ["HEAD", "OPTIONS"]) add({ name: `${method} ${target}`, method, target });
}

// Dataset files, per version.
for (const v of VERSIONS) {
  const root = `/datasets/gtnh/${v}`;
  add({
    name: `files ${v} lookup index`,
    method: "GET",
    target: `${root}/recipe-lookup-index.json.gz`,
    save: [{ from: "header", name: "etag", as: `etag:lookup:${v}` }],
  });
  add({
    name: `files ${v} lookup index If-None-Match`,
    method: "GET",
    target: `${root}/recipe-lookup-index.json.gz`,
    headers: { "If-None-Match": `{etag:lookup:${v}}` },
  });
  add({
    name: `files ${v} lookup index Range`,
    method: "GET",
    target: `${root}/recipe-lookup-index.json.gz`,
    headers: { Range: "bytes=0-99" },
  });
  add({
    name: `files ${v} shard`,
    method: "GET",
    target: `${root}/recipes-shards/shard-0000.json.gz`,
  });
  add({
    name: `files ${v} client-files listing`,
    method: "GET",
    target: `/api/datasets/${v}/client-files`,
    save: [{ from: "json", path: "files.catalog", as: `client:catalog:${v}` }],
  });
  for (const encoding of ["br", "gzip", "identity"]) {
    add({
      name: `files ${v} client catalog ${encoding}`,
      method: "GET",
      target: `{client:catalog:${v}}`,
      headers: { "Accept-Encoding": encoding },
    });
  }
  add({
    name: `files ${v} rendered texture`,
    method: "GET",
    target: `${root}/textures/rendered/${RENDERED_TEXTURE[v]}`,
  });
  for (const file of ["recipe-index.json.gz", "resource-index.json.gz", "recipes.json.gz"]) {
    add({ name: `files ${v} ${file}`, method: "GET", target: `${root}/${file}` });
  }
  // The gate lets these through to the public files: a texture report and a texture deeper than a root.
  add({
    name: `files ${v} texture report`,
    method: "GET",
    target: `${root}/textures/icon-report.json`,
  });
  add({
    name: `files ${v} deeper texture`,
    method: "GET",
    target: `${root}/textures/rendered/deeper/x.png`,
  });
  add({
    name: `files ${v} atlas texture`,
    method: "GET",
    target: `${root}/textures/atlas/atlas-0000.png`,
  });
  for (const textureRoot of ["rendered", "icons", "atlas", "nei-layouts"]) {
    add({
      name: `files ${v} missing ${textureRoot} texture`,
      method: "GET",
      target: `${root}/textures/${textureRoot}/missing-000000000000.png`,
    });
  }
  add({ name: `files ${v} recipes.json`, method: "GET", target: `${root}/recipes.json` });
}

// The dataset sweep: the golden harness's request set (dataset-responses.local.test.ts) as HTTP requests.
const SORTS = [
  "relevance",
  "name",
  "mod",
  "recipes",
  "made",
  "uses",
  "popular",
  "nei",
  "nei-filter",
];
const STEEL_INGOT = ["item", "gregtech:gt.metaitem.01@11305"];
const STEEL_PLATE = ["item", "gregtech:gt.metaitem.01@17305"];
const WATER = ["fluid", "water"];
const OXYGEN = ["fluid", "oxygen"];
const CIRCUIT_2 = ["item", "gregtech:gt.integrated_circuit@2"];
const ORE_PLATE_STEEL = ["item", "oredict:plateSteel"];
const GLASS = ["item", "minecraft:glass"];
const clause = (role, [kind, id]) => `${role}:${kind}:${id}`;
const RECIPE_ID_PICKS = [0, 1, 1000, 32300, 32600, 33500, 100000, 200000, -1];

for (const v of VERSIONS) {
  const api = `/api/datasets/${v}`;
  const sweep = (label, target, extra = {}) =>
    add({ name: `sweep ${v} ${label}`, method: "GET", target, ...extra });
  sweep("catalog", `${api}/catalog`);
  sweep("catalog fingerprinted", `${api}/catalog?datasetHash={hash:${v}}&appVersion={build}`);
  sweep("recipe-ids", `${api}/recipe-ids`, {
    save: [
      ...RECIPE_ID_PICKS.map((index) => ({
        from: "json",
        path: `recipeIds.${index}`,
        as: `recipe-id:${v}:${index}`,
      })),
    ],
  });
  sweep("crops", `${api}/crops`, {
    save: [{ from: "json", path: "crops.0.id", as: `crop-id:${v}` }],
  });
  sweep("mobs", `${api}/mobs`, { save: [{ from: "json", path: "mobs.0.id", as: `mob-id:${v}` }] });

  const resources = (label, params) =>
    sweep(`resources ${label}`, `${api}/resources${query(params)}`);
  for (const sort of SORTS) {
    for (const kind of [undefined, "item", "fluid"]) {
      resources(`blank sort=${sort} kind=${kind ?? ""}`, {
        query: "",
        offset: 0,
        limit: 24,
        kind,
        sort,
      });
    }
  }
  for (const source of ["plants", "bees"]) {
    for (const sort of ["relevance", "name"]) {
      resources(`blank source=${source} sort=${sort}`, {
        query: "",
        offset: 0,
        limit: 24,
        source,
        sort,
      });
    }
  }
  for (const mod of ["gregtech", "minecraft"])
    resources(`blank mod=${mod}`, { query: "", offset: 0, limit: 24, mod });
  for (const [offset, limit] of [
    [24, 24],
    [1000, 120],
    [60000, 120],
  ]) {
    resources(`blank page ${offset}/${limit}`, { query: "", offset, limit });
  }
  for (const text of [
    "steel",
    "plate",
    "oak log",
    "vaccum",
    "oaklog",
    "gt",
    "x",
    "ab",
    "steel plate",
  ]) {
    for (const sort of ["relevance", "name", "made", "nei", "nei-filter"]) {
      resources(`query=${text} sort=${sort}`, { query: text, offset: 0, limit: 24, sort });
    }
  }
  resources("query=steel kind=fluid", { query: "steel", offset: 0, limit: 24, kind: "fluid" });
  resources("query=steel mod=gregtech page 24", {
    query: "steel",
    offset: 24,
    limit: 24,
    mod: "gregtech",
  });
  resources("query=seed source=plants", { query: "seed", offset: 0, limit: 24, source: "plants" });
  resources("query=steel sort=popular", { query: "steel", offset: 0, limit: 24, sort: "popular" });

  const recipes = (label, params) =>
    sweep(
      `recipes ${label}`,
      `${api}/recipes${query({ query: "", maxTier: "all", offset: 0, limit: 48, ...params })}`,
    );
  for (const text of [
    "gt",
    "x",
    "ab",
    "steel",
    "steel plate",
    "ebf",
    "platinum group sludge",
    "vaccum pump",
    "oaklog",
    "hydrogen sulfide",
    "circuit",
  ]) {
    recipes(`query=${text}`, { query: text });
    recipes(`query=${text} allMaps`, { query: text, allMaps: 1 });
  }
  for (const offset of [48, 500])
    recipes(`query=steel allMaps offset=${offset}`, { query: "steel", allMaps: 1, offset });
  recipes("query=gt allMaps offset=5000 limit=120", {
    query: "gt",
    allMaps: 1,
    offset: 5000,
    limit: 120,
  });
  recipes("query=steel maxTier=LV allMaps", { query: "steel", allMaps: 1, maxTier: "LV" });
  recipes("resource=steel ingot mode=recipes", {
    resourceKind: STEEL_INGOT[0],
    resourceId: STEEL_INGOT[1],
    mode: "recipes",
  });
  recipes("resource=water mode=uses", {
    resourceKind: WATER[0],
    resourceId: WATER[1],
    mode: "uses",
  });
  recipes("resource=water mode=uses recipeMap=Chemical Reactor", {
    resourceKind: WATER[0],
    resourceId: WATER[1],
    mode: "uses",
    recipeMap: "Chemical Reactor",
  });
  recipes("makes steel ingot allMaps", { clause: clause("makes", STEEL_INGOT), allMaps: 1 });
  recipes("makes steel ingot Blast Furnace", {
    clause: clause("makes", STEEL_INGOT),
    recipeMap: "Blast Furnace",
  });
  recipes("takes water allMaps page 2", { clause: clause("takes", WATER), allMaps: 1, offset: 48 });
  recipes("takes water allMaps offset=2000 limit=120", {
    clause: clause("takes", WATER),
    allMaps: 1,
    offset: 2000,
    limit: 120,
  });
  recipes("takes circuit 2 allMaps", { clause: clause("takes", CIRCUIT_2), allMaps: 1 });
  recipes("takes plateSteel allMaps", { clause: clause("takes", ORE_PLATE_STEEL), allMaps: 1 });
  recipes("takes steel plate allMaps", { clause: clause("takes", STEEL_PLATE), allMaps: 1 });
  for (const op of ["any", "all", "only"]) {
    recipes(`takes water+oxygen ${op}`, {
      clause: [clause("takes", WATER), clause("takes", OXYGEN)],
      takesOp: op,
      allMaps: 1,
    });
  }
  recipes("takes glass makes steel any", {
    clause: [clause("takes", GLASS), clause("makes", STEEL_INGOT)],
    allMaps: 1,
  });
  recipes("makes steel ingot only", {
    clause: clause("makes", STEEL_INGOT),
    makesOp: "only",
    allMaps: 1,
  });
  recipes("takes water query=hydrogen", {
    clause: clause("takes", WATER),
    query: "hydrogen",
    allMaps: 1,
  });
  recipes("takes water maxTier=HV", { clause: clause("takes", WATER), maxTier: "HV", allMaps: 1 });
  recipes("takes water exclude Chemical Reactor", {
    clause: clause("takes", WATER),
    allMaps: 1,
    mapMode: "exclude",
    map: ["Chemical Reactor", "Large Chemical Reactor"],
  });
  recipes("takes water include Mixer", {
    clause: clause("takes", WATER),
    allMaps: 1,
    mapMode: "include",
    map: "Mixer",
  });
  recipes("takes water include none", {
    clause: clause("takes", WATER),
    allMaps: 1,
    mapMode: "include",
  });
  recipes("query=steel exclude Assembler", {
    query: "steel",
    allMaps: 1,
    mapMode: "exclude",
    map: "Assembler",
  });
  recipes("Blast Furnace map browse page 3", {
    clause: clause("takes", OXYGEN),
    recipeMap: "Blast Furnace",
    offset: 96,
  });

  for (const index of RECIPE_ID_PICKS) {
    sweep(`recipe by id #${index}`, `${api}/recipes/{recipe-id:${v}:${index}|uri}`, {
      save: [1000, 32600, 100000].includes(index)
        ? [{ from: "json", path: "", as: `recipe:${v}:${index}` }]
        : undefined,
    });
  }
  if (HAS_CROPS[v]) sweep("recipe by id crop", `${api}/recipes/{crop-id:${v}|uri}`);
  sweep("recipe by id mob", `${api}/recipes/{mob-id:${v}|uri}`);
  sweep("recipe by id missing", `${api}/recipes/no-such-recipe`);
  add({
    name: `sweep ${v} resolve-recipes`,
    method: "POST",
    target: `${api}/resolve-recipes`,
    headers: JSON_TYPE,
    needs: [1000, 32600, 100000].map((index) => `recipe:${v}:${index}`),
    body: (vars) => {
      const refs = [];
      for (const index of [1000, 32600, 100000]) {
        const recipe = vars.get(`recipe:${v}:${index}`);
        if (!recipe || typeof recipe !== "object") continue;
        const ref = {
          id: `imported-${index}`,
          name: recipe.name,
          machineType: recipe.machineType,
          recipeMap: recipe.source?.recipeMap,
          inputs: recipe.inputs,
          outputs: recipe.outputs,
          durationTicks: recipe.durationTicks,
          eut: recipe.eut,
        };
        refs.push(ref, { ...ref, id: `imported-${index}-eu`, eut: (recipe.eut ?? 0) + 1 });
        if (recipe.source?.rawRecipeId) {
          refs.push({
            id: `imported-${index}-raw`,
            name: recipe.name,
            machineType: recipe.machineType,
            rawRecipeId: recipe.source.rawRecipeId,
            inputs: recipe.inputs,
            outputs: [{ kind: "item", id: "nothing:at-all", amount: 1 }, ...recipe.outputs],
            durationTicks: recipe.durationTicks,
            eut: recipe.eut,
          });
        }
      }
      return JSON.stringify({ recipes: refs });
    },
  });
}

// The dataset path gate: the encoded spellings of dataset-path-gate.test.ts, then the spellings around it, as
// src/test-support/dataset-gate-cases.ts lists them for every reader.
for (const v of VERSIONS) {
  for (const { target, localOnly } of harnessGateCases(v)) {
    add({
      name: `gate ${v} ${target}`,
      method: "GET",
      target,
      ...(localOnly ? { localOnly } : {}),
    });
  }
}

// Trailing slashes and path spellings, sent raw.
for (const target of ["/api/%76ersion/", "/a%20b/", "/a%2Fb/"]) {
  add({ name: `slash ${target}`, method: "GET", target, localOnly: true });
}
add({ name: "spelling /api/version/", method: "GET", target: "/api/version/" });
for (const target of [
  "/api/version/?a=1",
  "/api/version/?a&b=x+y",
  "/API/version",
  "//api/version",
  "//api/./version",
  "/api\\version",
  "/api//version",
  "/api/./version",
  "/api/%2e/version",
  "/api/%2E/version",
  "/api/x/../version",
  "/api/%76ersion",
]) {
  add({ name: `spelling ${target}`, method: "GET", target, localOnly: true });
}

// Cross-site writes.
const EVIL = { Origin: "https://evil.example" };
add({
  name: "cross-site /api/community/auth/logout",
  method: "POST",
  target: "/api/community/auth/logout",
  headers: EVIL,
  body: "{}",
});
add({
  name: "cross-site /API/community/auth/logout",
  method: "POST",
  target: "/API/community/auth/logout",
  headers: EVIL,
  body: "{}",
});
for (const target of [
  "//api/community/auth/logout",
  "/api/community/auth/logout/",
  "/x/../api/community/auth/logout",
  "/x/%2e%2e/api/community/auth/logout",
]) {
  add({
    name: `cross-site ${target}`,
    method: "POST",
    target,
    headers: EVIL,
    body: "{}",
    localOnly: true,
  });
}
add({
  name: "cross-site Sec-Fetch-Site",
  method: "POST",
  target: "/api/community/auth/logout",
  headers: { "Sec-Fetch-Site": "cross-site" },
  body: "{}",
});
add({
  name: "same-site Origin",
  method: "POST",
  target: "/api/community/auth/logout",
  headers: { Origin: "https://parity.example" },
  body: "{}",
});

// Body caps.
add({
  name: "cap login 17 KiB Content-Length",
  method: "POST",
  target: "/api/community/auth/login",
  headers: { ...JSON_TYPE, "X-Client-Ip": "192.0.2.5" },
  body: BIG_LOGIN,
  bodyBytes: Buffer.byteLength(BIG_LOGIN),
});
add({
  name: "cap login 17 KiB chunked",
  method: "POST",
  target: "/api/community/auth/login",
  headers: { ...JSON_TYPE, "X-Client-Ip": "192.0.2.5" },
  body: BIG_LOGIN,
  bodyBytes: Buffer.byteLength(BIG_LOGIN),
  chunked: true,
});
add({
  name: "cap board image 6 MiB",
  method: "POST",
  target: "/api/community/images",
  headers: { "Content-Type": MULTIPART_TYPE, "X-Client-Ip": "192.0.2.6" },
  body: BIG_IMAGE_FORM,
  bodyBytes: BIG_IMAGE_FORM.length,
  strict: true,
});

// Rate limits a fresh address reaches within a few requests: sign-ups (5 an hour) and sign-ins (20 in 10 minutes).
for (let index = 1; index <= 6; index += 1) {
  add({
    name: `rate register ${index}`,
    method: "POST",
    target: "/api/community/auth/register",
    headers: { ...JSON_TYPE, "X-Client-Ip": "198.51.100.1" },
    body: JSON.stringify({ username: `parity-rate-${index}`, password: PASSWORD }),
  });
}
for (let index = 1; index <= 21; index += 1) {
  add({
    name: `rate login ${index}`,
    method: "POST",
    target: "/api/community/auth/login",
    headers: { ...JSON_TYPE, "X-Client-Ip": "198.51.100.2" },
    body: JSON.stringify({ username: "parity-rate-1", password: "wrong-password-00" }),
  });
}

add({
  name: "no Host header",
  method: "GET",
  target: "/api/version",
  headers: { Host: null },
  localOnly: true,
});
add({
  name: "nextOnly throw",
  method: "GET",
  target: "/api/__parity-throw",
  nextOnly: true,
  localOnly: true,
});
add({
  name: "nextOnly malformed escape",
  method: "GET",
  target: "/api/__parity-param/%E0%A4%A",
  nextOnly: true,
  localOnly: true,
});

// ---------------------------------------------------------------------------
// The scenario: accounts, library, blueprints, the community, images, sign-out.

const steps = [];
const step = (entry) =>
  steps.push({ modes: BOTH, ...entry, headers: { "X-Client-Ip": "192.0.2.10", ...entry.headers } });
const as = (who, headers = {}) => ({ Cookie: `{cookie:${who}}`, ...headers });
const jsonAs = (who) => as(who, JSON_TYPE);

for (const who of ["a", "b"]) {
  step({
    name: `scenario register ${who}`,
    method: "POST",
    target: "/api/community/auth/register",
    headers: JSON_TYPE,
    body: JSON.stringify({ username: `parity-${who}`, password: PASSWORD }),
  });
}
for (const who of ["a", "b"]) {
  step({
    name: `scenario login ${who}`,
    method: "POST",
    target: "/api/community/auth/login",
    headers: JSON_TYPE,
    body: JSON.stringify({ username: `parity-${who}`, password: PASSWORD }),
    save: [{ from: "cookie", name: "gtnh_session", as: `cookie:${who}` }],
  });
}
step({ name: "scenario me a", method: "GET", target: "/api/community/auth/me", headers: as("a") });
step({
  name: "scenario search b finds a",
  method: "GET",
  target: "/api/accounts/search?q=parity-a",
  headers: as("b"),
  save: [{ from: "json", path: "accounts.0.id", as: "id:a" }],
});
step({
  name: "scenario search a finds b",
  method: "GET",
  target: "/api/accounts/search?q=parity-b",
  headers: as("a"),
  save: [{ from: "json", path: "accounts.0.id", as: "id:b" }],
});

step({ name: "scenario library list", method: "GET", target: "/api/library", headers: as("a") });
step({
  name: "scenario folder create",
  method: "PUT",
  target: "/api/library/folders/parity-folder-1",
  headers: jsonAs("a"),
  body: JSON.stringify({ name: "Parity folder", createdAt: STAMP, updatedAt: STAMP }),
});
step({
  name: "scenario folder rename",
  method: "PUT",
  target: "/api/library/folders/parity-folder-1",
  headers: jsonAs("a"),
  body: JSON.stringify({
    name: "Parity folder renamed",
    createdAt: STAMP,
    updatedAt: "2026-10-27T10:05:00.000Z",
  }),
});
step({
  name: "scenario design save",
  method: "PUT",
  target: "/api/library/designs/parity-design-1",
  headers: jsonAs("a"),
  body: designBody("Parity design"),
});
step({
  name: "scenario library list after save",
  method: "GET",
  target: "/api/library",
  headers: as("a"),
});
step({
  name: "scenario design read as b refused",
  method: "GET",
  target: "/api/library/designs/parity-design-1?owner={id:a}",
  headers: as("b"),
});
step({
  name: "scenario design share with b",
  method: "PUT",
  target: "/api/library/designs/parity-design-1/members/{id:b}",
  headers: as("a"),
});
step({
  name: "scenario design read as b",
  method: "GET",
  target: "/api/library/designs/parity-design-1?owner={id:a}",
  headers: as("b"),
});
step({
  name: "scenario design members",
  method: "GET",
  target: "/api/library/designs/parity-design-1/members",
  headers: as("a"),
});
step({
  name: "scenario design member remove",
  method: "DELETE",
  target: "/api/library/designs/parity-design-1/members/{id:b}",
  headers: as("a"),
});
step({
  name: "scenario design read as b after removal",
  method: "GET",
  target: "/api/library/designs/parity-design-1?owner={id:a}",
  headers: as("b"),
});

step({
  name: "scenario design delete",
  method: "DELETE",
  target: "/api/library/designs/parity-design-1",
  headers: as("a"),
});
step({
  name: "scenario folder delete",
  method: "DELETE",
  target: "/api/library/folders/parity-folder-1",
  headers: as("a"),
});
step({
  name: "scenario library list after deletes",
  method: "GET",
  target: "/api/library",
  headers: as("a"),
});

step({
  name: "scenario blueprint save",
  method: "POST",
  target: "/api/blueprints",
  headers: jsonAs("a"),
  body: blueprintBody,
  save: [{ from: "json", path: "blueprint.id", as: "blueprintId" }],
});
step({
  name: "scenario blueprint list",
  method: "GET",
  target: "/api/blueprints",
  headers: as("a"),
});
step({
  name: "scenario blueprint read",
  method: "GET",
  target: "/api/blueprints/{blueprintId}",
  headers: as("a"),
});
step({
  name: "scenario blueprint edit",
  method: "PUT",
  target: "/api/blueprints/{blueprintId}",
  headers: jsonAs("a"),
  body: blueprintBody.replace('"Parity blueprint"', '"Parity blueprint edited"'),
});
step({
  name: "scenario blueprint public list",
  method: "GET",
  target: "/api/blueprints?scope=public",
  headers: as("a"),
});
step({
  name: "scenario blueprint delete",
  method: "DELETE",
  target: "/api/blueprints/{blueprintId}",
  headers: as("a"),
});

const community = (entry) => step({ modes: ON, ...entry });
community({
  name: "scenario community publish",
  method: "POST",
  target: "/api/community/plans",
  headers: jsonAs("a"),
  body: publishBody,
  save: [{ from: "json", path: "id", as: "planId" }],
});
community({
  name: "scenario community list",
  method: "GET",
  target: "/api/community/plans?sort=new",
});
community({
  name: "scenario community detail",
  method: "GET",
  target: "/api/community/plans/{planId}",
});
community({
  name: "scenario community view",
  method: "POST",
  target: "/api/community/plans/{planId}/view",
});
community({
  name: "scenario community vote a",
  method: "POST",
  target: "/api/community/plans/{planId}/vote",
  headers: jsonAs("a"),
  body: JSON.stringify({ deviceId: "parity-device-a", value: 1 }),
});
// Anonymous casts from one address on one plan: 3 a day, the 4th refused.
for (let index = 1; index <= 4; index += 1) {
  community({
    name: `scenario community vote anonymous ${index}`,
    method: "POST",
    target: "/api/community/plans/{planId}/vote",
    headers: { ...JSON_TYPE, "X-Client-Ip": "198.51.100.3" },
    body: JSON.stringify({ deviceId: `parity-device-${index}`, value: 1 }),
  });
}
community({
  name: "scenario community comment",
  method: "POST",
  target: "/api/community/plans/{planId}/comments",
  headers: jsonAs("b"),
  body: JSON.stringify({ body: "A comment for the parity run." }),
  save: [{ from: "json", path: "comment.id", as: "commentId" }],
});
community({
  name: "scenario community comments",
  method: "GET",
  target: "/api/community/plans/{planId}/comments",
});
community({
  name: "scenario community comment delete",
  method: "DELETE",
  target: "/api/community/plans/{planId}/comments/{commentId}",
  headers: as("b"),
});
community({
  name: "scenario community comments after delete",
  method: "GET",
  target: "/api/community/plans/{planId}/comments",
});
community({
  name: "scenario community preview upload",
  method: "POST",
  target: "/api/community/plans/{planId}/preview",
  headers: as("a", { "Content-Type": MULTIPART_TYPE }),
  body: IMAGE_FORM,
});
community({
  name: "scenario community preview",
  method: "GET",
  target: "/api/community/plans/{planId}/preview",
});
community({
  name: "scenario community download",
  method: "POST",
  target: "/api/community/plans/{planId}/download",
});
community({
  name: "scenario community account search",
  method: "GET",
  target: "/api/accounts/search?q=parity",
  headers: as("a"),
});
community({ name: "scenario page /?plan=", method: "GET", target: "/?plan={planId}" });
community({
  name: "scenario page /community?plan=",
  method: "GET",
  target: "/community?plan={planId}",
});
community({
  name: "scenario community detail as owner",
  method: "GET",
  target: "/api/community/plans/{planId}",
  headers: as("a"),
});
community({
  name: "scenario community edit",
  method: "PUT",
  target: "/api/community/plans/{planId}",
  headers: jsonAs("a"),
  body: publishBody.replace('"A plan for the parity run."', '"An edited plan for the parity run."'),
});
// The account's shares: 10 an hour, so the first publish and 9 more pass, and the next is refused.
for (let index = 2; index <= 11; index += 1) {
  community({
    name: `scenario community publish limit ${index}`,
    method: "POST",
    target: "/api/community/plans",
    headers: jsonAs("a"),
    body: publishBody.replace('"Parity plan"', `"Parity plan ${index}"`),
  });
}
community({
  name: "scenario community delete",
  method: "DELETE",
  target: "/api/community/plans/{planId}",
  headers: as("a"),
});
community({
  name: "scenario community detail after delete",
  method: "GET",
  target: "/api/community/plans/{planId}",
});

step({
  name: "scenario board image upload",
  method: "POST",
  target: "/api/community/images",
  headers: { "Content-Type": MULTIPART_TYPE },
  body: IMAGE_FORM,
  save: [{ from: "json", path: "url", as: "imageUrl", pathOnly: true }],
});
step({ name: "scenario board image read", method: "GET", target: "{imageUrl}" });
step({ name: "scenario resource popularity", method: "GET", target: "/api/resource-popularity" });
step({
  name: "scenario logout a",
  method: "POST",
  target: "/api/community/auth/logout",
  headers: jsonAs("a"),
  body: "{}",
});
step({
  name: "scenario logout everywhere b",
  method: "POST",
  target: "/api/community/auth/logout",
  headers: jsonAs("b"),
  body: JSON.stringify({ everywhere: true }),
});
step({
  name: "scenario me b after everywhere",
  method: "GET",
  target: "/api/community/auth/me",
  headers: as("b"),
});

/** @type {import("./requests.d.mts").Case[]} */
export const CASES = cases;
/** @type {import("./requests.d.mts").Step[]} */
export const SCENARIO = steps;

const names = new Set();
for (const entry of [...CASES, ...SCENARIO]) {
  if (names.has(entry.name)) throw new Error(`http-parity: two cases are named ${entry.name}`);
  names.add(entry.name);
}
