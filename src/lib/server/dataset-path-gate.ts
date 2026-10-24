/**
 * What a request path under the datasets may do, decided on the decoded path
 * before Next's public-file handler or any rewrite sees it.
 *
 * Next matches a rewrite on the path as sent but serves a public file by the
 * decoded path, so a percent-encoded name ("recipes%2Ejson", "%72ecipes.json",
 * an encoded slash, an encoded letter in "datasets") passes every rewrite and
 * reaches the public handler, which serves everything under
 * public/datasets/gtnh. src/proxy.ts runs this on every request path: a
 * dataset path is refused when it is encoded at all or holds a "." or ".."
 * segment; the index gzips, the shards and the raw recipes.json go to the
 * dataset-files route, which serves the first two and refuses the raw file;
 * everything else beside the data (textures, oracle reports, stray copies) is
 * still served by the public handler. The gate is one process's view of a
 * path: the raw recipes.json must not exist on the server either.
 */

export const DATASET_PUBLIC_PREFIX = "/datasets/gtnh/";
export const DATASET_FILES_PREFIX = "/dataset-files/";

const INDEX_FILES = new Set([
  "recipes.json",
  "recipes.json.gz",
  "recipe-index.json.gz",
  "recipe-lookup-index.json.gz",
  "resource-index.json.gz",
]);
const SHARDS_DIRECTORY = "recipes-shards";

export type DatasetPathDecision =
  | { kind: "pass" }
  | { kind: "refuse" }
  | { kind: "rewrite"; pathname: string };

const PASS: DatasetPathDecision = { kind: "pass" };
const REFUSE: DatasetPathDecision = { kind: "refuse" };

export function decideDatasetPath(rawPathname: string): DatasetPathDecision {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    // Not even valid encoding: refuse it if it could be aimed at the data.
    return /^\/(datasets|dataset-files)(\/|%2f)/i.test(rawPathname) ||
      rawPathname.toLowerCase().startsWith("/%")
      ? REFUSE
      : PASS;
  }
  const underData =
    decoded.startsWith(DATASET_PUBLIC_PREFIX) || decoded.startsWith(DATASET_FILES_PREFIX);
  if (!underData) {
    return PASS;
  }
  if (decoded !== rawPathname) {
    return REFUSE;
  }
  const segments = decoded.split("/").slice(1);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return REFUSE;
  }
  if (decoded.startsWith(DATASET_FILES_PREFIX)) {
    return PASS;
  }

  const [, , version, ...rest] = segments;
  if (version === undefined) {
    return PASS;
  }
  if (rest.length === 1 && rest[0] !== undefined && INDEX_FILES.has(rest[0])) {
    return { kind: "rewrite", pathname: `${DATASET_FILES_PREFIX}${version}/${rest[0]}` };
  }
  if (rest.length === 2 && rest[0] === SHARDS_DIRECTORY) {
    return { kind: "rewrite", pathname: `${DATASET_FILES_PREFIX}${version}/${rest[0]}/${rest[1]}` };
  }
  return PASS;
}
