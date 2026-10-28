import { buildIdentity } from "./build-identity.mjs";

/**
 * The build values inlined into the bundles, as `process.env.<NAME>` literals.
 *
 * The browser has no `process`, so every name browser code reads must be
 * defined here or the page throws `process is not defined` at load
 * (src/client/client-env.test.ts walks the browser code and holds the list).
 *
 * - NEXT_PUBLIC_MOD_AND_COMMUNITY and NEXT_PUBLIC_GTNH_BUILD_ID are always
 *   defined: the switch is "" when unset, so the server can compare the
 *   build's value with the running process's (deployment-features.ts), and the
 *   build id is the dataset answers' cache key (build-identity.mjs).
 * - The other names are their value when set at build, else left undefined,
 *   never "": the `??` fallbacks that read them (remote.ts, site-url.ts) must
 *   still fire.
 */
const ALWAYS = ["NEXT_PUBLIC_MOD_AND_COMMUNITY", "NEXT_PUBLIC_GTNH_BUILD_ID"];
const WHEN_SET = [
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_LIVE_URL",
  "NEXT_PUBLIC_GTNH_DATASET_MANIFEST_URL",
];

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ keepUnset: boolean }} options
 * @returns {Record<string, string>}
 */
function publicDefines(env, { keepUnset }) {
  /** @type {Record<string, string>} */
  const out = {
    "process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY": JSON.stringify(
      env.NEXT_PUBLIC_MOD_AND_COMMUNITY ?? "",
    ),
    "process.env.NEXT_PUBLIC_GTNH_BUILD_ID": JSON.stringify(buildIdentity(env)),
  };
  for (const name of WHEN_SET) {
    const value = env[name];
    if (value !== undefined) {
      out[`process.env.${name}`] = JSON.stringify(value);
    } else if (keepUnset) {
      out[`process.env.${name}`] = "undefined";
    }
  }
  return out;
}

/**
 * The browser bundle's defines: every public name, an unset one as the
 * literal `undefined`, and NODE_ENV (`"production"` unless `mode` says
 * otherwise, as the dev server does).
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ mode?: string }} [options]
 * @returns {Record<string, string>}
 */
export function clientDefines(env, { mode = "production" } = {}) {
  return {
    ...publicDefines(env, { keepUnset: true }),
    "process.env.NODE_ENV": JSON.stringify(mode),
  };
}

/**
 * The server bundle's defines: the same public names, except that an unset
 * one is left out, so the server reads it from its process at run time as
 * Next's server did. NODE_ENV is the process's own.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function serverDefines(env) {
  return publicDefines(env, { keepUnset: false });
}

/** The names `clientDefines` always defines, for the browser-code check. */
export const CLIENT_ENV_NAMES = [...ALWAYS, ...WHEN_SET, "NODE_ENV"];
