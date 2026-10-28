import type http from "node:http";

export interface ShutdownOptions {
  /** How long open requests may take to finish before every connection is closed. */
  graceMs: number;
  exit: (code: number) => void;
  /** Releases what the server holds (closeServerResources), after the last request. */
  close: () => Promise<void>;
}

/** The longest the release may take once the grace has run out, so a hung pool never outlives the stop. */
const CLOSE_BOUND_MS = 2_000;

/** The exit code of a process stopped by the signal, 128 plus its number, as Next's server exits. */
const SIGNAL_EXIT: Record<"SIGTERM" | "SIGINT", number> = { SIGTERM: 143, SIGINT: 130 };

/**
 * The stop a SIGTERM or SIGINT runs: stop accepting, close the idle keep-alive connections, let open requests
 * finish (each connection closes as its answer ends), then release the resources and exit. Past `graceMs`
 * every connection is closed and the stop goes on. A second signal exits at once. The grace stays under the
 * compose stop timeout (20 s), so the stop is the server's own and never Docker's kill.
 */
export function installShutdown(
  server: http.Server,
  options: ShutdownOptions,
): (signal?: "SIGTERM" | "SIGINT") => Promise<void> {
  let stopping: Promise<void> | undefined;
  // A connection that was busy when the stop began closes as soon as its answer has gone out.
  server.on("request", (_req, res) => {
    res.on("finish", () => {
      if (stopping) server.closeIdleConnections();
    });
  });
  return (signal = "SIGTERM") => {
    const code = SIGNAL_EXIT[signal];
    if (stopping) {
      options.exit(code);
      return stopping;
    }
    stopping = new Promise<void>((resolve) => {
      let finished = false;
      const finish = async (bounded: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(grace);
        const released = options.close().catch((error: unknown) => {
          console.error("Releasing the server's resources failed.", error);
        });
        await (bounded
          ? Promise.race([
              released,
              new Promise((done) => setTimeout(done, CLOSE_BOUND_MS).unref()),
            ])
          : released);
        options.exit(code);
        resolve();
      };
      const grace = setTimeout(() => {
        server.closeAllConnections();
        void finish(true);
      }, options.graceMs);
      grace.unref();
      server.close(() => void finish(false));
      server.closeIdleConnections();
    });
    return stopping;
  };
}
