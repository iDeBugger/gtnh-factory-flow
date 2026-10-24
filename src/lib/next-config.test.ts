import { expect, test } from "vitest";
import nextConfig from "../../next.config";

test("the image optimizer is off, so /_next/image is a 404 and no picture reaches sharp", () => {
  // The app has no next/image import; the route would only hand same-origin PNGs (uploads, dataset
  // textures) to sharp's native decoder and burn CPU on uncached resizes.
  expect(nextConfig.images?.unoptimized).toBe(true);
});
