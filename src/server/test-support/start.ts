// The source entry the spawned SIGTERM test runs through tsx, as dist/server/server.mjs runs the bundle.
// No top-level await: tsx compiles this file to CommonJS, which refuses one.
import { startServer } from "../main";

void startServer();
