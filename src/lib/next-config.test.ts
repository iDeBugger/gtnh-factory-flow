import { expect, test, vi } from "vitest";
import nextConfig from "../../next.config";

test("the image optimizer is off, so /_next/image is a 404 and no picture reaches sharp", () => {
  // The app has no next/image import; the route would only hand same-origin PNGs (uploads, dataset
  // textures) to sharp's native decoder and burn CPU on uncached resizes.
  expect(nextConfig.images?.unoptimized).toBe(true);
});

test("every answer carries Strict-Transport-Security for six months, without includeSubDomains, once", async () => {
  const rules = await nextConfig.headers!();
  const site = rules.find((rule) => rule.source === "/:path*");
  expect(site?.headers).toContainEqual({ key: "Strict-Transport-Security", value: "max-age=15552000" });
  const hsts = rules.flatMap((rule) => rule.headers).filter((header) => header.key === "Strict-Transport-Security");
  expect(hsts).toHaveLength(1);
});

test("the dataset backend rewrite forwards only a version made of a published name's characters", async () => {
  vi.stubEnv("GTNH_DATASET_BACKEND_URL", "http://backend.invalid/");
  vi.resetModules();
  try {
    const config = (await import("../../next.config")).default;
    const rewrites = await config.rewrites!();
    const beforeFiles = Array.isArray(rewrites) ? [] : (rewrites.beforeFiles ?? []);
    expect(beforeFiles.map((rule) => [rule.source, rule.destination])).toEqual([
      ["/api/datasets/:version([A-Za-z0-9._-]+)/:rest*", "http://backend.invalid/api/datasets/:version/:rest*"],
      ["/datasets/gtnh/:version([A-Za-z0-9._-]+)/:rest*", "http://backend.invalid/datasets/gtnh/:version/:rest*"],
    ]);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});
