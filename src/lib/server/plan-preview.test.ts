import { describe, expect, it } from "vitest";
import { pngHeader } from "@/test-support/png";
import { quietMarkdown, readPngHeader, sizePlanPreview } from "./plan-preview";

describe("the stored board photograph's header", () => {
  it("reads the size of a PNG whose first chunk is an IHDR within the bound", () => {
    expect(readPngHeader(pngHeader(1600, 1000))).toEqual({ width: 1600, height: 1000 });
    expect(readPngHeader(pngHeader(4096, 4096))).toEqual({ width: 4096, height: 4096 });
    expect(readPngHeader(pngHeader(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it("refuses a missing IHDR tag, a side over the bound, a zero side and a short file", () => {
    expect(readPngHeader(pngHeader(100, 100, "IDAT"))).toBeUndefined();
    expect(readPngHeader(pngHeader(5000, 10))).toBeUndefined();
    expect(readPngHeader(pngHeader(10, 4097))).toBeUndefined();
    expect(readPngHeader(pngHeader(60000, 60000))).toBeUndefined();
    expect(readPngHeader(pngHeader(0, 10))).toBeUndefined();
    expect(readPngHeader(pngHeader(100, 100).subarray(0, 24))).toBeUndefined();
    const notPng = pngHeader(100, 100);
    notPng[0] = 0x00;
    expect(readPngHeader(notPng)).toBeUndefined();
  });

  it("contain-fits a 1600 by 1000 picture into the card's box, and sizes nothing it refuses", () => {
    const sized = sizePlanPreview(pngHeader(1600, 1000));
    expect(sized).toMatchObject({ width: 528, height: 330 });
    expect(sized!.dataUri.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true);
    expect(sizePlanPreview(pngHeader(100, 100, "IDAT"))).toBeUndefined();
    expect(sizePlanPreview(pngHeader(5000, 10))).toBeUndefined();
  });
});

describe("player text on a markdown line", () => {
  it("cannot close its link text or open a link of its own", () => {
    expect(quietMarkdown("x](https://evil.example) [y")).toBe("x\\]\\(https://evil.example\\) \\[y");
    expect(quietMarkdown("<https://evil.example> `code` back\\slash")).toBe(
      "\\<https://evil.example\\> \\`code\\` back\\\\slash",
    );
  });

  it("stays on one line", () => {
    expect(quietMarkdown("a\n\nb  c")).toBe("a b c");
  });
});
