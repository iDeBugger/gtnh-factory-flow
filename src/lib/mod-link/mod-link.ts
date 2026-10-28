/**
 * "Open in the mod": the open plan sent to a running game with GTNH Planner installed. A page can reach a Java
 * process only over the loopback address, so the mod listens on 127.0.0.1, on the first free port of
 * `MOD_PORTS` (its `client/WebsiteListener`). It answers this site's origins only, and it opens nothing by
 * itself: the game asks the player first.
 *
 * Browsers guard requests from a public page to this computer. Chrome asks the player once (Local Network
 * Access) or wants a Private Network Access preflight, which the mod answers; Safari may refuse outright. Every
 * failure ends the same way: the caller copies the plan code for the planner's + tab.
 */

/** The ports the mod tries, in order: the same range as its listener. */
export const MOD_PORTS = Array.from({ length: 10 }, (_, index) => 25640 + index);

/** How long a probe waits: a game that is running answers in a few milliseconds. */
const PING_MS = 700;
/** How long sending waits: long enough for a browser's permission prompt to be answered. */
const SEND_MS = 60_000;

export interface ModGame {
  port: number;
  version: string;
}

/**
 * Whether this browser lets the page reach the computer it runs on: `granted`, `prompt` (it will ask the player
 * the first time), `denied`, or `unknown` (no such permission here, so nothing asks).
 */
export async function localNetworkPermission(): Promise<"granted" | "prompt" | "denied" | "unknown"> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
  for (const name of ["local-network-access", "loopback-network"]) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      return status.state;
    } catch {
      // Not a permission this browser knows.
    }
  }
  return "unknown";
}

function modUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

async function fetchWithin(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function ping(port: number, ms: number): Promise<ModGame> {
  const response = await fetchWithin(modUrl(port, "/ping"), { method: "GET" }, ms);
  if (!response.ok) throw new Error(`ping ${response.status}`);
  const body = (await response.json()) as { app?: unknown; version?: unknown };
  if (body.app !== "gtnhplanner") throw new Error("not the planner");
  return { port, version: typeof body.version === "string" ? body.version : "" };
}

/** The running game, found by trying every port at once; undefined when none answers in time. */
export async function findModGame(ms = PING_MS): Promise<ModGame | undefined> {
  try {
    return await Promise.any(MOD_PORTS.map((port) => ping(port, ms)));
  } catch {
    return undefined;
  }
}

/**
 * Sends a plan code to the game. True once the game has it (it then asks the player); false when no game took it,
 * for any reason: not running, the browser refused, or the player said no to the browser's prompt.
 */
export async function sendPlanToMod(
  code: string,
  name: string,
  known?: ModGame,
): Promise<boolean> {
  const game = known ?? (await findModGame(SEND_MS));
  if (!game) return false;
  try {
    const response = await fetchWithin(
      modUrl(game.port, "/open"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name }),
      },
      SEND_MS,
    );
    return response.status === 202;
  } catch {
    return false;
  }
}
