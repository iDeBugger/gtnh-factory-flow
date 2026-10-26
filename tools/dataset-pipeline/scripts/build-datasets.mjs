// Builds the datasets from the repo alone, on a machine with Docker:
//
//   node tools/dataset-pipeline/scripts/build-datasets.mjs <2.9|2.8.1|all>... [--export] [--out <dir>] [--work <dir>]
//
// --export first runs the GTNH client with the oracle in the pipeline image, the instance on its
// own Docker volume (case-sensitive: the pack has names that differ only in case). Without it the
// raw export from the last --export in the work dir is rebuilt. Then rebuild-dataset.sh, in the
// image: normalize, icon hints, NEI order, indexes, faint fluids, gzips. A build the publish
// checks would refuse (deploy-lib.mjs: unresolved icon hints, a lost NEI order) is not installed;
// one that passes replaces <out>/<id> and the manifest is rebuilt.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { datasetIconProblems, neiOrderVerdict } from "../../deploy/deploy-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The packs the app supports. The volume keeps the unpacked instance between runs; the zip is the
 * MultiMC/Prism client pack, kept in the work dir's cache once downloaded.
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
  },
  {
    id: "local-2.8.1",
    alias: "2.8.1",
    label: "2.8.1",
    oraclePack: "2.8.1",
    volume: "gtnh-281-client-instance",
    clientZipUrl: "https://downloads.gtnewhorizons.com/Multi_mc_downloads/GT_New_Horizons_2.8.1_Java_17-25.zip",
  },
];

export const USAGE = `Usage: node tools/dataset-pipeline/scripts/build-datasets.mjs <version>... [--export] [--out <dir>] [--work <dir>]

  <version>     ${PACKS.map((pack) => `${pack.alias} (${pack.id})`).join(", ")}, or all
  --export      run the client export first (needed once per pack, and after an oracle change)
  --out <dir>   where the datasets are installed (default public/datasets/gtnh)
  --work <dir>  raw exports, builds and caches (default .pipeline/datasets)`;

/** The command line as { packs, exportFirst, outDir, workDir }, or { error } / { help }. */
export function parseArgs(argv, cwd = process.cwd()) {
  const packs = [];
  let exportFirst = false;
  let outDir = path.join(repoRoot, "public", "datasets", "gtnh");
  let workDir = path.join(repoRoot, ".pipeline", "datasets");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--export") {
      exportFirst = true;
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
    } else if (arg === "all" || arg === "both") {
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
  return { packs: [...new Set(packs)], exportFirst, outDir, workDir };
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
 * Checks a built version and, when it passes, moves it to <out>/<id>; the copy it replaces goes
 * to <replacedDir>. Returns the problems, empty when it was installed.
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
    await move(installedDir, replacedDir);
  }
  await move(builtDir, installedDir);
  return [];
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

/** Runs a command, its output both on the console and in `logFile`; rejects on a non-zero exit. */
function run(command, args, { logFile, env } = {}) {
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

function dockerEnv(entries) {
  return Object.entries(entries).flatMap(([key, value]) => (value === undefined ? [] : ["-e", `${key}=${value}`]));
}

function containerPath(workDir, hostPath) {
  return `/work/${path.relative(workDir, hostPath).split(path.sep).join("/")}`;
}

async function exportPack(pack, { workDir, image }) {
  const buildDir = path.join(workDir, pack.id);
  const logFile = path.join(buildDir, "logs", "export.log");
  // A previous export's records and icons would mix into this one; it stays beside it for oracle-diff.mjs.
  const raw = path.join(buildDir, "raw-export");
  await fs.rm(`${raw}.previous`, { recursive: true, force: true });
  if (existsSync(raw)) await fs.rename(raw, `${raw}.previous`);
  await fs.rm(path.join(buildDir, "export"), { recursive: true, force: true });
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.mkdir(path.join(workDir, "cache"), { recursive: true });
  await run("docker", ["volume", "create", pack.volume]);
  await run(
    "docker",
    [
      "run", "--rm", "--name", `gtnh-export-${pack.alias.replaceAll(".", "")}`, "--shm-size=2g",
      "-v", `${repoRoot}:/workspace`, "-w", "/workspace",
      "-v", `${workDir}:/work`,
      "-v", `${pack.volume}:/instance`,
      ...dockerEnv({
        GTNH_DATASET_OUT_DIR: containerPath(workDir, path.join(buildDir, "export")),
        GTNH_RAW_EXPORT_DIR: containerPath(workDir, path.join(buildDir, "raw-export")),
        GTNH_INSTANCE_DIR: "/instance",
        GTNH_DATASET_VERSION_ID: pack.id,
        GTNH_DATASET_VERSION_LABEL: pack.label,
        GTNH_DATASET_CHANNEL: "local",
        GTNH_SOURCE_KIND: "pack-url",
        GTNH_SOURCE_REF: pack.label,
        GTNH_SOURCE_URL: pack.clientZipUrl,
        GTNH_ORACLE_PACK: pack.oraclePack,
        GTNH_EXPORT_PACK_KIND: "client",
        GTNH_EXPORT_PHASE: "client",
        GTNH_RENDER_STACK_ICONS: "true",
        GTNH_EXPORT_POSTPROCESS: "false",
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
}

async function rebuildPack(pack, { workDir, outDir, image }) {
  const buildDir = path.join(workDir, pack.id);
  const logFile = path.join(buildDir, "logs", "build.log");
  if (!existsSync(path.join(buildDir, "raw-export", "oracle-export.json"))) {
    throw new Error(`${pack.id} has no raw export in ${buildDir}/raw-export: run with --export.`);
  }
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, "");
  const installedDir = path.join(outDir, pack.id);
  // An export without NEI's list carries the order on from the installed copy.
  const previous = existsSync(installedDir) ? ["-v", `${installedDir}:/previous:ro`] : [];
  await run(
    "docker",
    [
      "run", "--rm", "--name", `gtnh-build-${pack.alias.replaceAll(".", "")}`,
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

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.error) {
    console.error(`${options.error}\n\n${USAGE}`);
    return 2;
  }
  const { packs, exportFirst, outDir, workDir } = options;
  const image = process.env.GTNH_DATASET_DOCKER_IMAGE ?? "gtnh-factory-flow-dataset:java21";
  await fs.mkdir(workDir, { recursive: true });
  // The Dockerfile copies nothing from its context, so the context is its own directory.
  await run("docker", ["build", "-t", image, path.join(repoRoot, "tools", "dataset-pipeline", "docker")]);

  const refused = [];
  let installed = 0;
  for (const pack of packs) {
    const started = Date.now();
    if (exportFirst) {
      console.log(`\n== ${pack.id}: client export`);
      await exportPack(pack, { workDir, image });
    }
    console.log(`\n== ${pack.id}: rebuild`);
    await rebuildPack(pack, { workDir, outDir, image });
    const problems = await installBuilt({
      builtDir: path.join(workDir, pack.id, "dataset"),
      outDir,
      id: pack.id,
      replacedDir: path.join(workDir, pack.id, "replaced"),
      allowLoss: process.env.GTNH_ALLOW_NO_NEI_ORDER === "1",
    });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`${pack.id}: ${problem}`);
      console.error(`${pack.id}: NOT installed; the build stays in ${path.join(workDir, pack.id, "dataset")}.`);
      refused.push(pack.id);
      continue;
    }
    installed += 1;
    console.log(`${pack.id}: installed in ${path.join(outDir, pack.id)} (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  if (installed > 0) {
    await run("node", ["tools/dataset-pipeline/scripts/rebuild-manifest.mjs"], {
      env: { ...process.env, GTNH_DATASETS_ROOT: outDir },
    });
  }
  return refused.length > 0 ? 1 : 0;
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
