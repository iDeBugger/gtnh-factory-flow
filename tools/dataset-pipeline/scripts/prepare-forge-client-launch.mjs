import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const instanceRootArg = process.argv[2];
const runtimeDirArg = process.argv[3];

if (!instanceRootArg || !runtimeDirArg) {
  throw new Error("Usage: prepare-forge-client-launch.mjs <instance-root> <runtime-dir>");
}

const instanceRoot = path.resolve(instanceRootArg);
const runtimeDir = path.resolve(runtimeDirArg);
const minecraftVersion = process.env.GTNH_MINECRAFT_VERSION ?? "1.7.10";
const javaMemory = process.env.GTNH_EXPORT_MAX_MEMORY ?? "6G";
const assetsDir = path.join(runtimeDir, "assets");
const librariesDir = path.join(runtimeDir, "libraries");
const versionsDir = path.join(runtimeDir, "versions", minecraftVersion);
const nativesDir = path.join(runtimeDir, "natives");
const xdgDataDir = path.join(runtimeDir, "xdg-data");

await fs.mkdir(runtimeDir, { recursive: true });
await fs.mkdir(librariesDir, { recursive: true });
await fs.mkdir(versionsDir, { recursive: true });
await fs.mkdir(nativesDir, { recursive: true });
await fs.mkdir(xdgDataDir, { recursive: true });

const versionInfo = await minecraftVersionInfo(minecraftVersion);
await downloadFile(
  versionInfo.downloads.client.url,
  path.join(versionsDir, `${minecraftVersion}.jar`),
);
await downloadLibraries(versionInfo);
await downloadMultiMcPatchLibraries();
await downloadKnownForgeLibraries();
await downloadAssets(versionInfo);

const classpath = await buildClasspath();
const mainClass = await selectMainClass(classpath);
const launchScript = path.join(runtimeDir, "launch-gtnh-client.sh");
await fs.writeFile(
  launchScript,
  `#!/usr/bin/env bash
set -euo pipefail
cd ${shellQuote(instanceRoot)}
mkdir -p ${shellQuote(xdgDataDir)}
export XDG_DATA_HOME=${shellQuote(xdgDataDir)}
exec java \\
  -Xms4G \\
  -Xmx${shellQuote(javaMemory)} \\
  -Dfile.encoding=UTF-8 \\
  -Djava.system.class.loader=com.gtnewhorizons.retrofuturabootstrap.RfbSystemClassLoader \\
  --enable-native-access=ALL-UNNAMED \\
  --add-opens=java.base/java.io=ALL-UNNAMED \\
  --add-opens=java.base/java.lang.invoke=ALL-UNNAMED \\
  --add-opens=java.base/java.lang.ref=ALL-UNNAMED \\
  --add-opens=java.base/java.lang.reflect=ALL-UNNAMED \\
  --add-opens=java.base/java.lang=ALL-UNNAMED \\
  --add-opens=java.base/java.net.spi=ALL-UNNAMED \\
  --add-opens=java.base/java.net=ALL-UNNAMED \\
  --add-opens=java.base/java.nio.channels=ALL-UNNAMED \\
  --add-opens=java.base/java.nio.charset=ALL-UNNAMED \\
  --add-opens=java.base/java.nio.file=ALL-UNNAMED \\
  --add-opens=java.base/java.nio=ALL-UNNAMED \\
  --add-opens=java.base/java.text=ALL-UNNAMED \\
  --add-opens=java.base/java.time.chrono=ALL-UNNAMED \\
  --add-opens=java.base/java.time.format=ALL-UNNAMED \\
  --add-opens=java.base/java.time.temporal=ALL-UNNAMED \\
  --add-opens=java.base/java.time.zone=ALL-UNNAMED \\
  --add-opens=java.base/java.time=ALL-UNNAMED \\
  --add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED \\
  --add-opens=java.base/java.util.concurrent.locks=ALL-UNNAMED \\
  --add-opens=java.base/java.util.jar=ALL-UNNAMED \\
  --add-opens=java.base/java.util.zip=ALL-UNNAMED \\
  --add-opens=java.base/java.util=ALL-UNNAMED \\
  --add-opens=java.base/jdk.internal.loader=ALL-UNNAMED \\
  --add-opens=java.base/jdk.internal.misc=ALL-UNNAMED \\
  --add-opens=java.base/jdk.internal.ref=ALL-UNNAMED \\
  --add-opens=java.base/jdk.internal.reflect=ALL-UNNAMED \\
  --add-opens=java.base/sun.nio.ch=ALL-UNNAMED \\
  --add-opens=java.desktop/com.sun.imageio.plugins.png=ALL-UNNAMED \\
  --add-opens=java.desktop/sun.awt.image=ALL-UNNAMED \\
  --add-opens=java.desktop/sun.awt=ALL-UNNAMED \\
  --add-opens=java.sql.rowset/javax.sql.rowset.serial=ALL-UNNAMED \\
  --add-opens=jdk.dynalink/jdk.dynalink.beans=ALL-UNNAMED \\
  --add-opens=jdk.naming.dns/com.sun.jndi.dns=ALL-UNNAMED \\
  -Djava.library.path=${shellQuote(nativesDir)} \\
  -Dorg.lwjgl.librarypath=${shellQuote(nativesDir)} \\
  -cp ${shellQuote(classpath)} \\
  ${mainClass} \\
  --username GTNHFactoryFlow \\
  --version ${shellQuote(minecraftVersion + "-Forge")} \\
  --gameDir ${shellQuote(instanceRoot)} \\
  --assetsDir ${shellQuote(assetsDir)} \\
  --assetIndex ${shellQuote(versionInfo.assets ?? minecraftVersion)} \\
  --uuid 00000000000000000000000000000000 \\
  --accessToken 0 \\
  --userProperties '{}' \\
  --userType legacy \\
  --tweakClass cpw.mods.fml.common.launcher.FMLTweaker
`,
);

await fs.chmod(launchScript, 0o755);
console.log(launchScript);

async function minecraftVersionInfo(versionId) {
  const manifest = await fetchJson(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  );
  const entry = manifest.versions.find((version) => version.id === versionId);
  if (!entry) {
    throw new Error(`Minecraft version ${versionId} not found in launcher manifest.`);
  }
  return fetchJson(entry.url);
}

async function downloadLibraries(versionInfo) {
  for (const library of versionInfo.libraries ?? []) {
    if (!isAllowed(library.rules, library.name)) {
      continue;
    }

    const nativeClassifier = library.natives?.linux?.replace("${arch}", "64");
    const nativeDownload = nativeClassifier
      ? library.downloads?.classifiers?.[nativeClassifier]
      : undefined;
    const artifact = nativeDownload ?? library.downloads?.artifact;
    if (!artifact?.url || !artifact.path) {
      continue;
    }

    const target = path.join(librariesDir, ...artifact.path.split("/"));
    await downloadFile(artifact.url, target);

    if (nativeDownload) {
      extractNatives(target);
    }
  }
}

async function downloadAssets(versionInfo) {
  const assetIndex = versionInfo.assetIndex;
  if (!assetIndex?.url) {
    return;
  }

  const indexPath = path.join(assetsDir, "indexes", `${assetIndex.id}.json`);
  await downloadFile(assetIndex.url, indexPath);
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const virtualRoot = path.join(assetsDir, "virtual", "legacy");

  for (const [assetPath, asset] of Object.entries(index.objects ?? {})) {
    const hash = asset.hash;
    if (!hash) {
      continue;
    }

    const objectPath = path.join(assetsDir, "objects", hash.slice(0, 2), hash);
    await downloadFile(
      `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
      objectPath,
    );

    if (index.virtual) {
      const legacyPath = path.join(virtualRoot, ...assetPath.split("/"));
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      if (!existsSync(legacyPath)) {
        await fs.copyFile(objectPath, legacyPath);
      }
    }
  }
}

async function downloadMultiMcPatchLibraries() {
  const patchRoot = await findPatchRoot(instanceRoot);
  if (!patchRoot) {
    return;
  }

  const patchesDir = path.join(patchRoot, "patches");
  const patchFiles = (await fs.readdir(patchesDir)).filter((name) => name.endsWith(".json")).sort();
  for (const patchFile of patchFiles) {
    const patch = JSON.parse(await fs.readFile(path.join(patchesDir, patchFile), "utf8"));
    for (const library of patch.libraries ?? []) {
      if (!isAllowed(library.rules, library.name) || !library.name) {
        continue;
      }

      const maven = mavenArtifact(library.name);
      if (!maven) {
        continue;
      }

      const target = path.join(librariesDir, ...maven.path.split("/"));
      const urls = [
        library.downloads?.artifact?.url,
        library.url ? `${library.url.replace(/\/+$/, "")}/${maven.path}` : undefined,
        `https://nexus.gtnewhorizons.com/repository/public/${maven.path}`,
        `https://maven.minecraftforge.net/${maven.path}`,
        `https://libraries.minecraft.net/${maven.path}`,
        `https://repo1.maven.org/maven2/${maven.path}`,
      ].filter(Boolean);

      try {
        await downloadFirst(urls, target);
      } catch (error) {
        console.warn(`Skipping unresolved MultiMC library ${library.name}: ${error.message}`);
      }
    }
  }
}

async function downloadKnownForgeLibraries() {
  await downloadMavenArtifact("net.minecraft:launchwrapper:1.12", [
    "https://libraries.minecraft.net",
    "https://repo1.maven.org/maven2",
  ]);
}

async function downloadMavenArtifact(coordinates, repositories) {
  const maven = mavenArtifact(coordinates);
  if (!maven) {
    throw new Error(`Invalid Maven coordinates: ${coordinates}`);
  }

  const target = path.join(librariesDir, ...maven.path.split("/"));
  await downloadFirst(
    repositories.map((repo) => `${repo.replace(/\/+$/, "")}/${maven.path}`),
    target,
  );
}

async function findPatchRoot(startDir) {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(path.join(current, "patches"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return undefined;
}

async function buildClasspath() {
  const jars = [
    ...(await findJars(librariesDir)),
    ...(await findJars(path.join(instanceRoot, "libraries"))),
    path.join(versionsDir, `${minecraftVersion}.jar`),
  ];

  const uniqueJars = [...new Set(jars.filter((jar) => existsSync(jar)))];
  const filteredJars = filterLegacyLwjgl2(preferMinecraftGuava(uniqueJars));
  if (!filteredJars.some((jar) => jar.toLowerCase().includes("launchwrapper"))) {
    throw new Error("Could not find launchwrapper in GTNH/Minecraft libraries.");
  }

  return filteredJars.join(":");
}

function preferMinecraftGuava(jars) {
  const hasGuava17 = jars.some((jar) =>
    jar.replace(/\\/g, "/").includes("/com/google/guava/guava/17.0/guava-17.0.jar"),
  );
  if (!hasGuava17) {
    return jars;
  }

  return jars.filter((jar) => {
    const normalized = jar.replace(/\\/g, "/");
    if (!normalized.includes("/com/google/guava/guava/")) {
      return true;
    }
    return normalized.includes("/com/google/guava/guava/17.0/guava-17.0.jar");
  });
}

function filterLegacyLwjgl2(jars) {
  return jars.filter((jar) => {
    const normalized = jar.replace(/\\/g, "/");
    return !(
      normalized.includes("/org/lwjgl/lwjgl/lwjgl/2.9.1/") ||
      normalized.includes("/org/lwjgl/lwjgl/lwjgl_util/2.9.1/") ||
      normalized.includes("/org/lwjgl/lwjgl/lwjgl-platform/2.9.1/")
    );
  });
}

async function selectMainClass(classpath) {
  const candidates = [
    "com.gtnewhorizons.retrofuturabootstrap.MainStartOnFirstThread",
    "com.gtnewhorizons.retrofuturabootstrap.Main",
  ];

  for (const candidate of candidates) {
    if (await classpathContainsClass(classpath, candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not find a RetroFuturaBootstrap main class in the GTNH classpath.");
}

async function classpathContainsClass(classpath, className) {
  const classFile = `${className.replace(/\./g, "/")}.class`;
  for (const jarPath of classpath.split(":")) {
    if (!jarPath.endsWith(".jar") || !existsSync(jarPath)) {
      continue;
    }

    const result = spawnSync("unzip", ["-l", jarPath, classFile], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.status === 0 && result.stdout.includes(classFile)) {
      return true;
    }
  }

  return false;
}

async function findJars(root) {
  if (!existsSync(root)) {
    return [];
  }

  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findJars(fullPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jar")) {
      found.push(fullPath);
    }
  }
  return found.sort();
}

async function downloadFile(url, filePath) {
  if (existsSync(filePath)) {
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await fs.writeFile(filePath, new Uint8Array(await response.arrayBuffer()));
}

async function downloadFirst(urls, filePath) {
  if (existsSync(filePath)) {
    return;
  }

  let lastError;
  for (const url of urls) {
    try {
      await downloadFile(url, filePath);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error(`No download URLs available for ${filePath}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function extractNatives(jarPath) {
  const result = spawnSync("unzip", ["-oq", jarPath, "-d", nativesDir], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to extract natives from ${jarPath}: ${result.stderr}`);
  }
}

// Prism names x86-64 Linux natives "linux" and ARM ones "linux-arm64". A plain jar
// limited to "linux" has no architecture, so it still loads on ARM.
function isAllowed(rules = [], name = "") {
  if (rules.length === 0) {
    return true;
  }

  const LINUX_OS = process.arch === "arm64" ? "linux-arm64" : "linux";
  const x64Natives = /-natives-linux:|:natives-linux$/.test(name);
  let allowed = false;
  for (const rule of rules) {
    const osMatches =
      !rule.os ||
      rule.os.name === LINUX_OS ||
      (rule.os.name === "linux" && LINUX_OS !== "linux" && !x64Natives);
    if (osMatches) {
      allowed = rule.action === "allow";
    }
  }
  return allowed;
}

function mavenArtifact(coordinates) {
  const parts = String(coordinates).split(":");
  if (parts.length < 3) {
    return undefined;
  }

  const [group, artifact, rawVersion, classifier] = parts;
  const version = rawVersion.split("@")[0];
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return {
    path: `${group.replace(/\./g, "/")}/${artifact}/${version}/${fileName}`,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
