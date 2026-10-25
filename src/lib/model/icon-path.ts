/**
 * Where a stored icon may point: the site's own art only, which is dataset
 * textures (`/datasets/gtnh/<version>/textures/...`) and the bundled NEI art
 * (`/nei/...`). A plan arrives from anywhere (a link, a paste, a file, a
 * post, a live edit) and its icon paths are `<img src>` and `url(...)` in
 * every viewer's browser, so an outside URL would make every viewer fetch an
 * attacker's address. Anything else is dropped on the way in (never a
 * refusal: an icon must not sink a plan load) and the landing refresh
 * restamps the dataset's icons.
 *
 * Segments start with a letter, digit, `_` or `-`, so `.` and `..` are
 * impossible, and the character class has no quote, parenthesis, space, `?`,
 * `#`, `\` or `:`, so the value is also safe inside an unquoted `url(...)`.
 */
export const ICON_PATH_MAX_LENGTH = 500;

const SITE_ICON_PATH =
  /^\/(datasets\/gtnh|nei)\/([A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(png|webp|gif|jpe?g)$/;

export function isSiteIconPath(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= ICON_PATH_MAX_LENGTH && SITE_ICON_PATH.test(value)
  );
}
