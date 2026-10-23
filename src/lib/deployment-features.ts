/**
 * Whether this deployment runs the in-game mod integration and the community
 * library. Off unless NEXT_PUBLIC_MOD_AND_COMMUNITY is exactly "on" (any case,
 * spaces trimmed): unset or any other value switches both off, so a fresh
 * deployment never answers the game or shows the library by accident.
 *
 * The variable is read by its literal name so Next.js inlines it, and it is
 * read at every call, never cached, so tests can stub it.
 */
export function isModAndCommunityOn(): boolean {
  return process.env.NEXT_PUBLIC_MOD_AND_COMMUNITY?.trim().toLowerCase() === "on";
}
