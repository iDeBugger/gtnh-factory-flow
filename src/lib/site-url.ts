/**
 * The site's own origin, for every absolute link it writes (metadata, robots,
 * sitemap, llms.txt, feedback issues, uploaded image URLs). It is
 * `NEXT_PUBLIC_SITE_URL`, a build value Next inlines (hence the literal
 * `process.env` access), without trailing slashes; unset or blank it is the
 * development server. Read at each call, never held in a module constant, so a
 * test can stub it.
 */
export function siteUrl(): string {
  const value = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");
  return value || "http://localhost:3000";
}
