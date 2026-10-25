#!/usr/bin/env node
// The deploy's check of the server's environment, run before anything starts:
//
//   node check-env.mjs /opt/gtnh/.env [more env files] --image-label "<org.gtnh.mod-and-community>" [--set NAME=value]
//
// Exits 1 naming every problem. A problem names the variable, never its value:
// the output lands in a terminal and a deploy log.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { verifyServiceToken } from "./service-token.mjs";

const REQUIRED = [
  "POSTGRES_PASSWORD",
  "POSTGREST_AUTHENTICATOR_PASSWORD",
  "POSTGREST_JWT_SECRET",
  "POSTGREST_SERVICE_TOKEN",
  "COMMUNITY_HASH_SALT",
  "LIVE_INTERNAL_TOKEN",
  "LIVE_ALLOWED_ORIGINS",
  "LIVE_TRUSTED_PROXIES",
  "GTNH_TAG",
];

/** Secrets a guess must not reach: at least this many characters. */
const LONG_SECRETS = ["COMMUNITY_HASH_SALT", "LIVE_INTERNAL_TOKEN", "POSTGREST_JWT_SECRET"];
const MIN_SECRET_LENGTH = 32;

/** Development-only switches a deployed stack must never carry. */
const FORBIDDEN = ["LOCAL_DB", "NODE_ENV"];

/** The narrowest proxy list a mistake can widen to: every peer inside may name any client address. */
const WIDEST_PREFIX = { 4: 24, 6: 120 };

/** Reads KEY=VALUE lines as compose's --env-file does: comments, blanks and surrounding quotes ignored. */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    env[name] = value;
  }
  return env;
}

/** The problems with LIVE_TRUSTED_PROXIES (the live service's grammar), each naming the variable. */
function trustedProxyProblems(value) {
  const problems = [];
  for (const entry of value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const slash = entry.indexOf("/");
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const family = isIP(address);
    if (family === 0) {
      problems.push("LIVE_TRUSTED_PROXIES holds an entry that is not an address or a subnet.");
      continue;
    }
    if (slash === -1) {
      continue;
    }
    const text = entry.slice(slash + 1);
    const prefix = Number(text);
    if (!/^\d{1,3}$/.test(text) || prefix > (family === 4 ? 32 : 128)) {
      problems.push("LIVE_TRUSTED_PROXIES holds an entry that is not an address or a subnet.");
    } else if (prefix < WIDEST_PREFIX[family]) {
      problems.push(
        `LIVE_TRUSTED_PROXIES holds a subnet wider than /${WIDEST_PREFIX[family]}: name the proxy's address.`,
      );
    }
  }
  return problems;
}

/**
 * Everything wrong with a deployed stack's environment. `image.modAndCommunity`
 * is the site image's org.gtnh.mod-and-community label: the value baked in at
 * build, which the run-time value must equal or every mod and community route
 * stays off. `options.rehearsal` accepts http:// origins (a workstation's stack).
 */
export function checkDeployEnv(env, image, options = {}) {
  const problems = [];
  const value = (name) => env[name] ?? "";
  for (const name of REQUIRED) {
    if (!value(name).trim()) {
      problems.push(`${name} is not set.`);
    }
  }
  for (const name of LONG_SECRETS) {
    if (value(name).trim() && value(name).length < MIN_SECRET_LENGTH) {
      problems.push(
        `${name} is shorter than ${MIN_SECRET_LENGTH} characters: use openssl rand -hex 32.`,
      );
    }
  }
  if (
    value("POSTGREST_SERVICE_TOKEN") &&
    value("POSTGREST_JWT_SECRET") &&
    !verifyServiceToken(value("POSTGREST_SERVICE_TOKEN"), value("POSTGREST_JWT_SECRET"))
  ) {
    problems.push(
      "POSTGREST_SERVICE_TOKEN is not a service_role token signed with POSTGREST_JWT_SECRET: make it with tools/deploy/service-token.mjs.",
    );
  }
  for (const name of FORBIDDEN) {
    if (name in env) {
      problems.push(`${name} must not be set on a deployed stack.`);
    }
  }
  if (value("NEXT_PUBLIC_MOD_AND_COMMUNITY") !== (image?.modAndCommunity ?? "")) {
    problems.push(
      "NEXT_PUBLIC_MOD_AND_COMMUNITY differs from the value the site image was built with: every mod and community route would stay off.",
    );
  }
  for (const origin of value("LIVE_ALLOWED_ORIGINS")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = undefined;
    }
    const schemes = options.rehearsal ? ["https:", "http:"] : ["https:"];
    if (
      !parsed ||
      !schemes.includes(parsed.protocol) ||
      parsed.origin !== origin.replace(/\/+$/, "")
    ) {
      problems.push(
        `LIVE_ALLOWED_ORIGINS holds an entry that is not an ${options.rehearsal ? "http(s)" : "https"} origin.`,
      );
    }
  }
  if (value("LIVE_TRUSTED_PROXIES").trim()) {
    problems.push(...trustedProxyProblems(value("LIVE_TRUSTED_PROXIES")));
  }
  return [...new Set(problems)];
}

function main(argv) {
  const files = [];
  const set = {};
  let label;
  let rehearsal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--image-label") {
      label = argv[++i] ?? "";
    } else if (arg === "--set") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) {
        set[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    } else if (arg === "--rehearsal") {
      rehearsal = true;
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0 || label === undefined) {
    console.error(
      "Usage: check-env.mjs <env file>... --image-label <value> [--set NAME=value] [--rehearsal]",
    );
    return 2;
  }
  let env = {};
  for (const file of files) {
    try {
      env = { ...env, ...parseEnvFile(readFileSync(file, "utf8")) };
    } catch {
      console.error(`Cannot read ${file}.`);
      return 1;
    }
  }
  const problems = checkDeployEnv({ ...env, ...set }, { modAndCommunity: label }, { rehearsal });
  for (const problem of problems) {
    console.error(`env: ${problem}`);
  }
  if (problems.length === 0) {
    console.log("env: ok");
  }
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
