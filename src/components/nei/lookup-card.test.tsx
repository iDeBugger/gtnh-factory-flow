// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CropRequirementNote } from "./lookup-card";

afterEach(cleanup);

it("says which block an IC2 crop card needs under it", () => {
  const { container } = render(
    <CropRequirementNote recipe={{ metadata: { cropOwner: "berriespp", requirements: ["Needs Red Granite under it"] } }} />,
  );
  expect(container.textContent).toBe("Needs Red Granite under it.");
});

it("says nothing for a plain IC2 crop, a CropsNH crop or any other recipe", () => {
  const { container } = render(
    <>
      <CropRequirementNote recipe={{ metadata: { cropOwner: "IC2" } }} />
      <CropRequirementNote
        recipe={{ metadata: { cropsNh: { tier: 3, requirements: ["Needs a block of andesite under it to grow"] } } }}
      />
      <CropRequirementNote recipe={{}} />
    </>,
  );
  expect(container.textContent).toBe("");
});
