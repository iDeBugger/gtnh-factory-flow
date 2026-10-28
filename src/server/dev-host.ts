/**
 * The address the dev server listens on: loopback, unless `HOSTNAME` names one on purpose. The dev server serves
 * the browser code's source through Vite, so it stays off the LAN by default.
 */
export function devListenHost(env: NodeJS.ProcessEnv): string {
  return env.HOSTNAME || "127.0.0.1";
}
