import { expect, test } from "vitest";
import { formulaNumber } from "./formula-lines";

test("formulaNumber groups whole numbers and rounds fractions by size", () => {
  expect(formulaNumber(1234567)).toBe("1,234,567");
  expect(formulaNumber(128.04)).toBe("128");
  expect(formulaNumber(1.234)).toBe("1.23");
  expect(formulaNumber(0.12345)).toBe("0.123");
  expect(formulaNumber(Number.NaN)).toBe("-");
});

test("formulaNumber holds a fixed number of decimals when asked", () => {
  expect(formulaNumber(128.04, 2)).toBe("128.04");
  expect(formulaNumber(1280.5, 2)).toBe("1,280.5");
  expect(formulaNumber(128, 2)).toBe("128");
});
