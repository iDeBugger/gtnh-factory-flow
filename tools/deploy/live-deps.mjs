#!/usr/bin/env node
// A run image's packages: the ones a bundle leaves external (esbuild's metafile) and everything they need at
// run time, read from package-lock.json the way Node resolves them. Copies each into <out>/node_modules (the
// Dockerfile's live-deps stage for the live bundle, its site-deps stage for the site's):
//
//   node tools/deploy/live-deps.mjs <package-lock.json> <metafile.json> <installed root> <out>
//
// Every dependency, optional dependency and peer is followed, whether the package loads it at import or
// later (pg loads pgpass only for a connection without a password), so a package the bundle reaches is in
// the image however late it is loaded. An optional dependency or optional peer that is not installed (absent
// from the lockfile's tree, or listed there but not on disk: another platform's binary such as
// @img/sharp-linux-x64) is skipped. A required package missing from either is an error.
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The package a bare specifier names: `pg`, `pg/lib/x` -> `pg`; `@a/b/c` -> `@a/b`. Null for node: and relative. */
export function packageName(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The packages the bundle imports and leaves external, from an esbuild metafile. */
export function externalPackages(metafile) {
  const names = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const entry of output.imports ?? []) {
      const name = entry.external ? packageName(entry.path) : null;
      if (name) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

/** Where Node finds `name` from the package at `from` (a lockfile key, "" for the root). */
function resolve(packages, from, name) {
  let dir = from;
  for (;;) {
    const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) {
      return candidate;
    }
    if (!dir) {
      return null;
    }
    const at = dir.lastIndexOf("node_modules/");
    dir = at > 0 ? dir.slice(0, at - 1) : "";
  }
}

/**
 * The lockfile keys (`node_modules/...`) of `roots` and their run-time closure, sorted. `installed(key)`
 * says whether a package is on disk; npm keeps another platform's optional packages in the lockfile
 * without installing them.
 */
export function runtimeClosure(lock, roots, installed = () => true) {
  const packages = lock.packages ?? {};
  const found = new Set();
  const queue = roots.map((name) => ({ from: "", name, optional: false, by: "the bundle" }));
  while (queue.length > 0) {
    const { from, name, optional, by } = queue.shift();
    const key = resolve(packages, from, name);
    if (!key || !installed(key)) {
      if (optional) {
        continue;
      }
      throw new Error(
        key
          ? `${key}, needed by ${by}, is in package-lock.json but not installed.`
          : `${name}, needed by ${by}, is not in package-lock.json's tree.`,
      );
    }
    if (found.has(key)) {
      continue;
    }
    const entry = packages[key];
    if (entry.link) {
      throw new Error(`${key} is a link; the image copies installed packages only.`);
    }
    found.add(key);
    const optionalPeers = entry.peerDependenciesMeta ?? {};
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      queue.push({ from: key, name: dep, optional: false, by: key });
    }
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) {
      queue.push({ from: key, name: dep, optional: true, by: key });
    }
    for (const dep of Object.keys(entry.peerDependencies ?? {})) {
      queue.push({ from: key, name: dep, optional: Boolean(optionalPeers[dep]?.optional), by: key });
    }
  }
  return [...found].sort();
}

function main([lockFile, metaFile, root, out]) {
  if (!lockFile || !metaFile || !root || !out) {
    console.error("Usage: live-deps.mjs <package-lock.json> <metafile.json> <installed root> <out>");
    process.exit(2);
  }
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  const roots = externalPackages(JSON.parse(readFileSync(metaFile, "utf8")));
  const keys = runtimeClosure(lock, roots, (key) => existsSync(path.join(root, key, "package.json")));
  for (const key of keys) {
    cpSync(path.join(root, key), path.join(out, key), { recursive: true, verbatimSymlinks: true });
  }
  console.log(`bundle packages: ${roots.join(" ")}; copied ${keys.length}: ${keys.map((k) => k.slice(13)).join(" ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
