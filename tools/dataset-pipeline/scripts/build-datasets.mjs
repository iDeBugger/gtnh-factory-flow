// Builds the datasets from the repo alone, on a machine with Docker:
//
//   node tools/dataset-pipeline/scripts/build-datasets.mjs <2.9|2.8.1|all>... [--export] [--carry-nei-order]
//     [--out <dir>] [--work <dir>]
//
// --export first runs the GTNH client with the oracle in the pipeline image, the instance on its
// own Docker volume (case-sensitive: the pack has names that differ only in case). Without it the
// raw export from the last good --export in the work dir is rebuilt. Then rebuild-dataset.sh, in
// the image: normalize, icon hints, NEI order, indexes, faint fluids, gzips. A build the publish
// checks would refuse (deploy-lib.mjs: unresolved icon hints, a lost NEI order) is not installed;
// one that passes replaces <out>/<id>, keeping the rendered textures it lacks, the power maps are
// pointed at it (refresh-power-maps.mjs), and the manifest is rebuilt.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { datasetIconProblems, neiOrderVerdict } from "../../deploy/deploy-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The packs the app supports. The volume keeps the unpacked instance between runs. The zip is the
 * MultiMC/Prism client pack, fetched from exactly this URL and used only when its bytes hash to
 * `sha256`: a re-upload under the same name must not slip another pack into a build.
 */
export const PACKS = [
  {
    id: "local-2.9.0-rc-2",
    alias: "2.9",
    label: "2.9.0-RC-2",
    oraclePack: "2.9",
    volume: "gtnh-rc2-client-instance",
    clientZipUrl:
      "https://downloads.gtnewhorizons.com/Multi_mc_downloads/betas/GT_New_Horizons_2.9.0-RC-2_Java_17-26.zip",
    sha256: "0c7da79f4ac1982c8a7dbfdcc1f1af6cf96ac5cb345a1c3387fb090d974b0a8d",
  },
  {
    id: "local-2.8.1",
    alias: "2.8.1",
    label: "2.8.1",
    oraclePack: "2.8.1",
    volume: "gtnh-281-client-instance",
    clientZipUrl: "https://downloads.gtnewhorizons.com/Multi_mc_downloads/GT_New_Horizons_2.8.1_Java_17-25.zip",
    sha256: "5d9772823802979f294b162eb3120ec7a8dcb54797324fa34fb2d24f7c38d6c3",
  },
];

export const USAGE = `Usage: node tools/dataset-pipeline/scripts/build-datasets.mjs <version>... [options]

  <version>          ${PACKS.map((pack) => `${pack.alias} (${pack.id})`).join(", ")}, or all
  --export           run the client export first (needed once per pack, and after an oracle change)
  --carry-nei-order  install an export whose NEI item list failed, carrying the installed copy's order
  --fresh-icons      render every icon again (empties the pack's icon cache): needed after a renderer change
  --power-maps       point src/lib/power/data at the build even with --out elsewhere (default: only for the default out)
  --out <dir>        where the datasets are installed (default public/datasets/gtnh)
  --work <dir>       raw exports, builds and caches (default .pipeline/datasets)`;

/** The command line as { packs, exportFirst, carryNeiOrder, freshIcons, outDir, workDir }, or { error } / { help }. */
export function parseArgs(argv, cwd = process.cwd()) {
  const packs = [];
  let exportFirst = false;
  let carryNeiOrder = false;
  let freshIcons = false;
  let powerMaps;
  let outDir = path.join(repoRoot, "public", "datasets", "gtnh");
  let workDir = path.join(repoRoot, ".pipeline", "datasets");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--export") {
      exportFirst = true;
    } else if (arg === "--carry-nei-order") {
      carryNeiOrder = true;
    } else if (arg === "--fresh-icons") {
      freshIcons = true;
    } else if (arg === "--power-maps") {
      powerMaps = true;
    } else if (arg === "--out" || arg === "--work") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        return { error: `${arg} needs a directory.` };
      }
      index += 1;
      if (arg === "--out") outDir = path.resolve(cwd, value);
      else workDir = path.resolve(cwd, value);
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option ${arg}.` };
    } else if (arg === "all") {
      packs.push(...PACKS);
    } else {
      const pack = PACKS.find((entry) => entry.id === arg || entry.alias === arg);
      if (!pack) {
        return { error: `Unknown version ${arg}: one of ${PACKS.map((entry) => entry.alias).join(", ")} or all.` };
      }
      packs.push(pack);
    }
  }
  if (packs.length === 0) {
    return { error: "Name a version, or all." };
  }
  if (path.resolve(outDir) === path.resolve(workDir)) {
    return { error: "--out and --work must differ." };
  }
  if (freshIcons && !exportFirst) {
    return { error: "--fresh-icons renders icons, so it needs --export." };
  }
  // The repo's power maps name the installed datasets: a build installed elsewhere leaves them alone unless asked.
  powerMaps ??= path.resolve(outDir) === path.join(repoRoot, "public", "datasets", "gtnh");
  return { packs: [...new Set(packs)], exportFirst, carryNeiOrder, freshIcons, powerMaps, outDir, workDir };
}

/** Whether a version directory's resource-index.json.gz carries NEI's order. */
export function hasNeiOrder(versionDir) {
  const file = path.join(versionDir, "resource-index.json.gz");
  if (!existsSync(file)) {
    return false;
  }
  return gunzipSync(readFileSync(file)).includes('"resourceOrder":[');
}

/**
 * Why a built version must not be installed, or [] when it may: the checks publish-datasets.sh
 * runs, with the installed copy standing for the served one.
 */
export async function buildProblems(builtDir, installedDir, { allowLoss = false } = {}) {
  const id = path.basename(installedDir);
  const problems = [];
  if (!existsSync(path.join(builtDir, "recipe-lookup-index.json.gz"))) {
    problems.push(`${id} has no recipe-lookup-index.json.gz: not a built dataset.`);
    return problems;
  }
  problems.push(...(await datasetIconProblems(builtDir)));
  const verdict = neiOrderVerdict(id, {
    local: hasNeiOrder(builtDir),
    served: hasNeiOrder(installedDir),
    allowLoss,
  });
  if (!verdict.ok) {
    problems.push(verdict.message);
  } else if (verdict.message.startsWith("WARNING")) {
    console.warn(verdict.message);
  }
  return problems;
}

/**
 * Checks a built version and, when it passes, installs it at <out>/<id>. The rendered textures
 * the installed copy has and the build lacks are copied into the build first, so the swap is two
 * renames: the installed copy to <replacedDir>, the build into its place. Returns the problems,
 * empty when it was installed.
 */
export async function installBuilt({ builtDir, outDir, id, replacedDir, allowLoss = false }) {
  const installedDir = path.join(outDir, id);
  const problems = await buildProblems(builtDir, installedDir, { allowLoss });
  if (problems.length > 0) {
    return problems;
  }
  await fs.mkdir(outDir, { recursive: true });
  await fs.rm(replacedDir, { recursive: true, force: true });
  if (existsSync(installedDir)) {
    await keepRenderedTextures(installedDir, builtDir);
    await move(installedDir, replacedDir);
  }
  await move(builtDir, installedDir);
  return [];
}

/**
 * Copies every rendered texture of `fromDir` that `toDir` lacks, as publishing adds textures
 * beside the served ones: saved plans cite names an earlier export drew, and a content name never
 * changes its bytes. Returns the count copied.
 */
export async function keepRenderedTextures(fromDir, toDir) {
  const from = path.join(fromDir, "textures", "rendered");
  const to = path.join(toDir, "textures", "rendered");
  if (!existsSync(from)) {
    return 0;
  }
  await fs.mkdir(to, { recursive: true });
  const present = new Set(await fs.readdir(to));
  let copied = 0;
  for (const name of await fs.readdir(from)) {
    if (present.has(name)) continue;
    await fs.copyFile(path.join(from, name), path.join(to, name), fsConstants.COPYFILE_FICLONE);
    copied += 1;
  }
  return copied;
}

async function move(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.cp(from, to, { recursive: true, preserveTimestamps: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

/** A file's SHA-256, hex. */
export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The pack's client zip in the cache, downloaded from the table's URL when it is missing or its
 * bytes are not the pinned ones; refused when a fresh download does not match either.
 */
export async function ensurePackZip(pack, workDir, { fetchImpl = fetch } = {}) {
  const zip = path.join(workDir, "cache", "pack", `${pack.id}-client.zip`);
  if (existsSync(zip) && (await sha256File(zip)) === pack.sha256) {
    return zip;
  }
  await fs.mkdir(path.dirname(zip), { recursive: true });
  console.log(`Downloading ${pack.clientZipUrl}`);
  const response = await fetchImpl(pack.clientZipUrl);
  if (!response.ok || !response.body) {
    throw new Error(`${pack.clientZipUrl}: ${response.status} ${response.statusText ?? ""}`.trim());
  }
  const partial = `${zip}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const actual = await sha256File(partial);
  if (actual !== pack.sha256) {
    await fs.rm(partial, { force: true });
    throw new Error(`${pack.clientZipUrl} has sha256 ${actual}, not the pinned ${pack.sha256}: the pack changed.`);
  }
  await fs.rename(partial, zip);
  return zip;
}

/**
 * The `neiItemList` status of a raw export, read from the file's end (the list is the root's
 * last key) so a 2 GB export is not parsed whole.
 */
export async function neiListStatus(exportFile) {
  const handle = await fs.open(exportFile, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 96 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const match = /"neiItemList"\s*:\s*\{\s*"status"\s*:\s*"([a-z_]+)"/.exec(buffer.toString("utf8"));
    return match ? match[1] : "absent";
  } finally {
    await handle.close();
  }
}

/** Runs a command, its output both on the console and in `logFile`; rejects on a non-zero exit. */
function runCommand(command, args, { logFile, env } = {}) {
  return new Promise((resolve, reject) => {
    const log = logFile ? createWriteStream(logFile, { flags: "a" }) : undefined;
    const child = spawn(command, args, { cwd: repoRoot, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    for (const [stream, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        sink.write(chunk);
        log?.write(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      log?.end();
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ""} exited with ${code}${logFile ? ` (log: ${logFile})` : ""}`));
    });
  });
}

/** Starts a log for this run, the last run's kept beside it as `.previous`. */
async function freshLog(logFile) {
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  if (existsSync(logFile)) await fs.rename(logFile, `${logFile}.previous`);
  await fs.writeFile(logFile, "");
}

function dockerEnv(entries) {
  return Object.entries(entries).flatMap(([key, value]) => (value === undefined ? [] : ["-e", `${key}=${value}`]));
}

function containerPath(workDir, hostPath) {
  return `/work/${path.relative(workDir, hostPath).split(path.sep).join("/")}`;
}

/** Containers run as the host user, so nothing they write into the repo or the work dir is root's. */
function hostUser() {
  const { uid, gid } = os.userInfo();
  return uid >= 0 ? ["--user", `${uid}:${gid}`, "-e", "HOME=/tmp"] : [];
}

async function exportPack(pack, { workDir, image, run, freshIcons }) {
  const buildDir = path.join(workDir, pack.id);
  const logFile = path.join(buildDir, "logs", "export.log");
  await freshLog(logFile);
  const zip = await (run.ensurePackZip ?? ensurePackZip)(pack, workDir);
  // Into fresh .new directories: a failed export leaves the last good one where it was.
  const raw = path.join(buildDir, "raw-export");
  const exported = path.join(buildDir, "export");
  for (const dir of [`${raw}.new`, `${exported}.new`]) await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(workDir, "cache"), { recursive: true });
  // The cache serves an icon by its stack, whatever renderer drew it: a renderer change needs it empty.
  if (freshIcons) await fs.rm(path.join(workDir, "cache", "icons", pack.id), { recursive: true, force: true });
  await run("docker", ["volume", "create", pack.volume]);
  // Earlier runs as root left the instance root's: hand it to the host user once per export.
  const { uid, gid } = os.userInfo();
  await run("docker", ["run", "--rm", "-v", `${pack.volume}:/instance`, image, "chown", "-R", `${uid}:${gid}`, "/instance"]);
  await run(
    "docker",
    [
      "run", "--rm", "--name", `gtnh-export-${pack.alias.replaceAll(".", "")}`, "--shm-size=2g",
      ...hostUser(),
      "-v", `${repoRoot}:/workspace`, "-w", "/workspace",
      "-v", `${workDir}:/work`,
      "-v", `${pack.volume}:/instance`,
      ...dockerEnv({
        GTNH_DATASET_OUT_DIR: containerPath(workDir, `${exported}.new`),
        GTNH_RAW_EXPORT_DIR: containerPath(workDir, `${raw}.new`),
        GTNH_INSTANCE_DIR: "/instance",
        GTNH_DATASET_VERSION_ID: pack.id,
        GTNH_DATASET_VERSION_LABEL: pack.label,
        GTNH_DATASET_CHANNEL: "local",
        GTNH_PACK_LOCAL_ZIP: containerPath(workDir, zip),
        GTNH_ORACLE_PACK: pack.oraclePack,
        GTNH_EXPORT_PACK_KIND: "client",
        GTNH_EXPORT_PHASE: "client",
        GTNH_RENDER_STACK_ICONS: "true",
        GTNH_PACK_CACHE_DIR: "/work/cache/pack",
        GTNH_ORACLE_BUILD_CACHE_DIR: "/work/cache/oracle-jar",
        GTNH_ICON_CACHE_DIR: `/work/cache/icons/${pack.id}`,
        GRADLE_USER_HOME: "/work/cache/gradle",
        GTNH_EXPORT_MAX_MEMORY: process.env.GTNH_EXPORT_MAX_MEMORY,
        GTNH_EXPORT_TIMEOUT_SECONDS: process.env.GTNH_EXPORT_TIMEOUT_SECONDS,
      }),
      image,
      "bash", "tools/dataset-pipeline/scripts/run-gtnh-oracle-export.sh",
    ],
    { logFile },
  );
  if (!existsSync(path.join(`${raw}.new`, "oracle-export.json"))) {
    throw new Error(`${pack.id}: the export wrote no oracle-export.json (log: ${logFile}).`);
  }
  // The previous good export stays beside the new one for oracle-diff.mjs.
  for (const dir of [raw, exported]) {
    await fs.rm(`${dir}.previous`, { recursive: true, force: true });
    if (existsSync(dir)) await fs.rename(dir, `${dir}.previous`);
    if (existsSync(`${dir}.new`)) await fs.rename(`${dir}.new`, dir);
  }
  return neiListStatus(path.join(raw, "oracle-export.json"));
}

async function rebuildPack(pack, { workDir, outDir, image, run }) {
  const buildDir = path.join(workDir, pack.id);
  const logFile = path.join(buildDir, "logs", "build.log");
  if (!existsSync(path.join(buildDir, "raw-export", "oracle-export.json"))) {
    throw new Error(`${pack.id} has no raw export in ${buildDir}/raw-export: run with --export.`);
  }
  await freshLog(logFile);
  const installedDir = path.join(outDir, pack.id);
  // An export without NEI's list carries the order on from the installed copy.
  const previous = existsSync(installedDir) ? ["-v", `${installedDir}:/previous:ro`] : [];
  await run(
    "docker",
    [
      "run", "--rm", "--name", `gtnh-build-${pack.alias.replaceAll(".", "")}`,
      ...hostUser(),
      "-v", `${repoRoot}:/workspace`, "-w", "/workspace",
      "-v", `${workDir}:/work`,
      "-v", `${pack.volume}:/instance:ro`,
      ...previous,
      ...dockerEnv({
        GTNH_DATASET_VERSION_ID: pack.id,
        GTNH_DATASET_VERSION_LABEL: pack.label,
        GTNH_INSTANCE_DIR: "/instance",
        GTNH_BUILD_DIR: containerPath(workDir, buildDir),
        GTNH_PREVIOUS_DATASET_DIR: previous.length > 0 ? "/previous" : undefined,
        GTNH_NEI_ORDER_CARRY: process.env.GTNH_NEI_ORDER_CARRY,
      }),
      image,
      "bash", "tools/dataset-pipeline/scripts/rebuild-dataset.sh",
    ],
    { logFile },
  );
}

/** One pack end to end; returns undefined when installed, else why not. */
/**
 * One pack end to end: { installed, problems }. A refusal (the publish checks, or a power map naming an id the build
 * lacks) comes before the swap, so a pack is either installed or untouched; a problem after the swap leaves it
 * installed and is reported as such.
 */
async function buildPack(pack, options) {
  const { workDir, outDir, exportFirst, carryNeiOrder, powerMaps, run } = options;
  if (exportFirst) {
    console.log(`\n== ${pack.id}: client export`);
    const status = await exportPack(pack, options);
    console.log(`${pack.id}: NEI item list ${status}`);
    // The list is what an export is for: one that failed is installed only when asked to carry the old order.
    if (status !== "exported" && !carryNeiOrder) {
      return {
        installed: false,
        problems: [`the export's NEI item list is ${status} (see the export log); --carry-nei-order installs it with the installed copy's order.`],
      };
    }
  }
  console.log(`\n== ${pack.id}: rebuild`);
  await rebuildPack(pack, options);
  const builtDir = path.join(workDir, pack.id, "dataset");
  const refresh = (dir, extra) => run("node", ["tools/dataset-pipeline/scripts/refresh-power-maps.mjs", dir, "--id", pack.id, ...extra]);
  if (powerMaps) {
    try {
      await refresh(builtDir, ["--check"]);
    } catch {
      return {
        installed: false,
        problems: [
          "a power map names an id this build lacks (see above); run tools/power-machine-icons.mjs or tools/power-resource-map.mjs for it.",
          `the build stays in ${builtDir}.`,
        ],
      };
    }
  }
  const problems = await installBuilt({
    builtDir,
    outDir,
    id: pack.id,
    replacedDir: path.join(workDir, pack.id, "replaced"),
    allowLoss: process.env.GTNH_ALLOW_NO_NEI_ORDER === "1",
  });
  if (problems.length > 0) {
    return { installed: false, problems: [...problems, `the build stays in ${builtDir}.`] };
  }
  if (powerMaps) {
    try {
      await refresh(path.join(outDir, pack.id), []);
    } catch (error) {
      return { installed: true, problems: [`installed, but the power maps were not refreshed: ${error?.message ?? error}`] };
    }
  }
  return { installed: true, problems: [] };
}

/**
 * The whole command. `run` (a command runner, with an optional `ensurePackZip`) is the only way
 * out to Docker and node, so tests drive it with a fake. Every pack runs even when one fails; the
 * manifest is rebuilt whenever one was installed, so it always names the installed bytes.
 */
export async function main(argv, { run = runCommand } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.error) {
    console.error(`${options.error}\n\n${USAGE}`);
    return 2;
  }
  const { packs, outDir, workDir } = options;
  const image = process.env.GTNH_DATASET_DOCKER_IMAGE ?? "gtnh-factory-flow-dataset:java21";
  await fs.mkdir(workDir, { recursive: true });
  // The Dockerfile copies nothing from its context, so the context is its own directory.
  await run("docker", ["build", "-t", image, path.join(repoRoot, "tools", "dataset-pipeline", "docker")]);

  const failed = [];
  const done = [];
  let installed = 0;
  for (const pack of packs) {
    const started = Date.now();
    let result;
    try {
      result = await buildPack(pack, { ...options, image, run });
    } catch (error) {
      result = { installed: false, problems: [error?.message ?? String(error)] };
    }
    for (const problem of result.problems) console.error(`${pack.id}: ${problem}`);
    if (result.problems.length > 0) failed.push(pack.id);
    if (!result.installed) {
      console.error(`${pack.id}: NOT installed.`);
      continue;
    }
    installed += 1;
    done.push(pack.id);
    console.log(`${pack.id}: installed in ${path.join(outDir, pack.id)} (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  if (installed > 0) {
    await run("node", ["tools/dataset-pipeline/scripts/rebuild-manifest.mjs"], {
      env: { ...process.env, GTNH_DATASETS_ROOT: outDir },
    });
  }
  console.log(
    `\nInstalled: ${done.length > 0 ? done.join(", ") : "none"}` +
      (failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""),
  );
  return failed.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error?.message ?? error);
      process.exit(1);
    },
  );
}
