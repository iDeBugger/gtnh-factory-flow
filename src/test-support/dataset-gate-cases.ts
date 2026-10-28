/**
 * The spellings of a dataset path that the gate must hold, as data. Three readers share them:
 * `src/lib/server/dataset-path-gate.test.ts` (the decision on a pathname), `src/server/app-gate.test.ts` (the
 * answer over a raw socket) and the parity harness (`tools/http-parity/requests.mjs`, which sends the harness
 * cases to Next and to Express and names each case by its target).
 *
 * This file imports nothing and uses only erasable TypeScript, so plain Node loads it for the harness.
 */

/** What `decideDatasetPath` says about the target read as a pathname. */
export type GateDecision = "pass" | "refuse" | "rewrite";

/** What the app answers for the target sent raw. */
export type GateAnswer =
  /** The gate's own 400, `{"error":"Invalid dataset path."}`, no-store. */
  | { kind: "refuse" }
  /** The gate rewrites the canonical path to the dataset-files route at `routed`. */
  | { kind: "rewrite"; routed: string }
  /** Next's 308 before the gate, to `location`. */
  | { kind: "redirect"; location: string }
  /** Nothing serves it: the 404 page. */
  | { kind: "notFound" }
  /** A file beside the data, served from the public dataset tree. */
  | { kind: "public" }
  /** It reaches the dataset-files route as sent. */
  | { kind: "route" }
  /** Node's HTTP parser refuses the target before the app sees it (a target that does not start with `/`). */
  | { kind: "badRequest" };

export interface GateCase {
  /** The request target, sent byte for byte. */
  target: string;
  decision: GateDecision;
  answer: GateAnswer;
  /** Skipped against stage, where Caddy cleans the spelling first. */
  localOnly: boolean;
}

const refuse: GateAnswer = { kind: "refuse" };
const notFound: GateAnswer = { kind: "notFound" };

/**
 * The harness's gate cases for one dataset version, in the harness's order: the encoded spellings of the gate's
 * unit test, then the spellings around it (case, trailing slash), then the review's (repeated slash, backslash,
 * encoded slash before `datasets`, dot segments).
 */
export function harnessGateCases(v: string): GateCase[] {
  const files = `/dataset-files/${v}`;
  const rewrite = (file: string): GateAnswer => ({ kind: "rewrite", routed: `${files}/${file}` });
  const redirect = (location: string): GateAnswer => ({ kind: "redirect", location });
  const local = (target: string, decision: GateDecision, answer: GateAnswer): GateCase => ({
    target,
    decision,
    answer,
    localOnly: true,
  });
  const both = (target: string, decision: GateDecision, answer: GateAnswer): GateCase => ({
    target,
    decision,
    answer,
    localOnly: false,
  });
  const root = `/datasets/gtnh/${v}`;
  return [
    local(`${root}/client%2Fcatalog.json`, "refuse", refuse),
    local(`${root}/client/../recipes.json`, "refuse", rewrite("recipes.json")),
    local(`${root}/recipes%2Ejson`, "refuse", refuse),
    local(`${root}/recipes%2ejson`, "refuse", refuse),
    local(`${root}/%72ecipes.json`, "refuse", refuse),
    local(`/datasets/gtnh/${v}%2Frecipes.json`, "refuse", refuse),
    local(`${root}/recipes%252Ejson`, "refuse", refuse),
    local(`/%64atasets/gtnh/${v}/recipes.json`, "refuse", refuse),
    local(`/datasets%2Fgtnh/${v}/recipes.json`, "refuse", refuse),
    local(`${root}/recipes%2Ejson.gz`, "refuse", refuse),
    local(`${root}/recipes-shards%2Fshard-0000.json.gz`, "refuse", refuse),
    local(`${root}/textures/rendered/x%2Epng`, "refuse", refuse),
    local(`${files}/recipes%2Ejson.gz`, "refuse", refuse),
    local(`${root}/%E0%A4%A`, "refuse", refuse),
    local(`${root}/../${v}/recipes.json`, "refuse", rewrite("recipes.json")),
    local(`${root}/./recipes.json`, "refuse", rewrite("recipes.json")),
    local(`/datasets/gtnh//${v}/recipes.json`, "refuse", redirect(`${root}/recipes.json`)),
    local(`${root}/oracle/oracle-report.json`, "pass", { kind: "public" }),
    local(`${files}/recipes.json.gz`, "pass", { kind: "route" }),
    both(`/DATASETS/gtnh/${v}/recipes.json`, "pass", notFound),
    both(`${root}/RECIPES.JSON`, "pass", notFound),
    both(`${root}/recipes.json/`, "refuse", redirect(`${root}/recipes.json`)),
    local(
      `//datasets/gtnh/${v}/recipe-lookup-index.json.gz`,
      "pass",
      redirect(`${root}/recipe-lookup-index.json.gz`),
    ),
    local(`/%2fdatasets/gtnh/${v}/recipes.json`, "pass", notFound),
    local(`/%2Fdatasets/gtnh/${v}/recipes.json`, "pass", notFound),
    local(`/x/..%2fdatasets/gtnh/${v}/recipes.json`, "pass", notFound),
    local(`\\datasets\\gtnh\\${v}\\recipe-lookup-index.json.gz`, "pass", { kind: "badRequest" }),
    local(
      `${root}/x/../recipe-lookup-index.json.gz`,
      "refuse",
      rewrite("recipe-lookup-index.json.gz"),
    ),
    local(
      `${root}/%2e/recipe-lookup-index.json.gz`,
      "refuse",
      rewrite("recipe-lookup-index.json.gz"),
    ),
  ];
}

/** Spellings the HTTP test sends beyond the harness's: a backslash and a repeated slash inside the path. */
export function extraGateCases(v: string): GateCase[] {
  const root = `/datasets/gtnh/${v}`;
  return [
    {
      target: `/datasets\\gtnh\\${v}\\recipes.json`,
      decision: "pass",
      answer: { kind: "redirect", location: `${root}/recipes.json` },
      localOnly: true,
    },
    {
      target: `${root}//recipe-lookup-index.json.gz`,
      decision: "refuse",
      answer: { kind: "redirect", location: `${root}/recipe-lookup-index.json.gz` },
      localOnly: true,
    },
    {
      target: `${root}/%2E/recipes.json`,
      decision: "refuse",
      answer: { kind: "rewrite", routed: `/dataset-files/${v}/recipes.json` },
      localOnly: true,
    },
  ];
}
