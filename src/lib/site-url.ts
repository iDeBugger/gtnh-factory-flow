/**
 * The site's own origin, for every absolute link it writes (metadata, robots,
 * sitemap, llms.txt, uploaded image URLs). It is
 * `NEXT_PUBLIC_SITE_URL`, a build value Next inlines (hence the literal
 * `process.env` access), without trailing slashes; unset or blank it is the
 * development server. Read at each call, never held in a module constant, so a
 * test can stub it.
 */
export function siteUrl(): string {
  const value = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");
  return value || "http://localhost:3000";
}

/**
 * The site's own host as images print it (the share card, the exported plan's
 * footer), from the same `NEXT_PUBLIC_SITE_URL`. Unset, blank or not a URL it
 * is undefined and the image prints no address: never the development server's
 * and never another site's.
 */
export function siteHost(): string | undefined {
  const value = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (!value) return undefined;
  try {
    return new URL(value).host || undefined;
  } catch {
    return undefined;
  }
}
