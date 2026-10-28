const NAME = "NEXT_PUBLIC_MOD_AND_COMMUNITY";

const isOn = (value: string | undefined) => value?.trim().toLowerCase() === "on";

/**
 * Whether this deployment runs the in-game mod integration and the community
 * library. Off unless NEXT_PUBLIC_MOD_AND_COMMUNITY is exactly "on" (any case,
 * spaces trimmed): unset or any other value switches both off, so a fresh
 * deployment never answers the game or shows the library by accident.
 *
 * The literal read is the build's value: the build's defines
 * (tools/build/define.mjs) always define the variable, so it is inlined in
 * both bundles. The
 * `Reflect.get` read is never inlined or folded into it: it is the running
 * process's value. On the server both must say on, so a site built one way
 * and started the other answers no mod or community route. The browser has
 * only the build's value. The live service (esbuild, no inlining) and tests
 * read the process for both. Read at every call, never cached, so tests can
 * stub it.
 */
export function isModAndCommunityOn(): boolean {
  const built = isOn(process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY);
  if (typeof window !== "undefined") {
    return built;
  }
  return built && isOn(Reflect.get(process.env, NAME) as string | undefined);
}
