/**
 * The address the dev server listens on: loopback, unless `HOSTNAME` names one on purpose. The dev server serves
 * the browser code's source through Vite, so it stays off the LAN by default.
 */
export function devListenHost(env: NodeJS.ProcessEnv): string {
  return env.HOSTNAME || "127.0.0.1";
}

/** The build values a production server has inlined by its build, and a dev server takes from Vite's defines. */
const BUILD_VALUES = ["NEXT_PUBLIC_GTNH_BUILD_ID", "NEXT_PUBLIC_MOD_AND_COMMUNITY"] as const;

/**
 * Sets the build values the server reads from its process to the ones Vite inlines into the browser code
 * (`define`, Vite's resolved defines). Run before the app's modules load, so `/api/version` and the dataset
 * answers' cache key name the page's build.
 */
export function setDevBuildEnv(env: NodeJS.ProcessEnv, define: Record<string, unknown> = {}): void {
  for (const name of BUILD_VALUES) {
    const literal = define[`process.env.${name}`];
    if (typeof literal !== "string") throw new Error(`Vite's config defines no ${name}.`);
    env[name] = JSON.parse(literal) as string;
  }
}
