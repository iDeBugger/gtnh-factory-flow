import { describe, expect, it } from "vitest";
import { ICON_PATH_MAX_LENGTH, isSiteIconPath } from "./icon-path";

describe("where a stored icon may point", () => {
  it("accepts the site's own art: dataset textures of any version and the bundled NEI art", () => {
    for (const path of [
      "/datasets/gtnh/local-2.9.0-rc-2/textures/rendered/sticky_resin-c45e34ab6e13.png",
      "/datasets/gtnh/local-2.9.0-beta-2/textures/item/x-0123456789ab.png",
      "/datasets/gtnh/local-2.8.1/textures/atlas/atlas-0001.png",
      "/datasets/gtnh/local-2.8.1/textures/fluid/gt.metafluid.01-a1b2c3d4e5f6.webp",
      "/nei/thaumcraft/aspects/ignis.png",
    ]) {
      expect(isSiteIconPath(path), path).toBe(true);
    }
  });

  it("refuses every other address, anything encoded, a query and a path that is not an image", () => {
    for (const path of [
      "http://example.invalid/x.png",
      "https://gtnhplanner.com/datasets/gtnh/v/textures/x.png",
      "//example.invalid/x.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "asset:gregtech:textures/aspects/RADIO.png",
      "/datasets/gtnh/../../etc/passwd",
      "/datasets/gtnh/v/textures/./a.png",
      "/datasets/gtnh/v/textures/a.png')",
      "/datasets/gtnh/v/textures/a.png?x=1",
      "/datasets/gtnh/v/textures/a.png#x",
      "/datasets/gtnh/v/textures/a b.png",
      "/datasets/gtnh/v/textures/a.svg",
      "/datasets/gtnh/v/textures/a.png/",
      "/datasets/gtnh//textures/a.png",
      "/datasets/gtnh/v/.hidden/a.png",
      "/datasets/gtnh/v/textures/a.PNG",
      "/power-art/x.png",
      "/mode-art/x.webp",
      "/datasets/other/v/a.png",
      "datasets/gtnh/v/textures/a.png",
      "",
    ]) {
      expect(isSiteIconPath(path), path).toBe(false);
    }
  });

  it("refuses a path over the length bound and anything that is not a string", () => {
    const stem = "/datasets/gtnh/v/textures/";
    const longest = `${stem}${"a".repeat(ICON_PATH_MAX_LENGTH - stem.length - 4)}.png`;
    expect(longest).toHaveLength(ICON_PATH_MAX_LENGTH);
    expect(isSiteIconPath(longest)).toBe(true);
    expect(isSiteIconPath(`${stem}${"a".repeat(ICON_PATH_MAX_LENGTH - stem.length - 3)}.png`)).toBe(false);
    for (const value of [undefined, null, 1, true, {}, [], ["/nei/thaumcraft/aspects/ignis.png"]]) {
      expect(isSiteIconPath(value)).toBe(false);
    }
  });
});
