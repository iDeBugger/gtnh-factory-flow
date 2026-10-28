import { config } from "zod";

/*
 * The page's policy allows no eval, so Zod's compiled parsers can never run on the main thread. Zod finds that
 * out by calling `Function("")`, which the browser reports as a policy violation; switching its compiler off
 * before any schema is built skips the probe, and parsing is the same. Workers have their own policy.
 */
config({ jitless: true });
