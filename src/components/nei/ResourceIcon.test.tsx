// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROGRAMMED_CIRCUIT_ITEM_ID } from "@/lib/model/programmed-circuit";
import { ResourceIcon } from "./ResourceIcon";

describe("ResourceIcon", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  describe("the programmed circuit", () => {
    const circuit = {
      kind: "item" as const,
      id: `${PROGRAMMED_CIRCUIT_ITEM_ID}@3`,
      amount: 0,
      displayName: "Programmed Circuit",
      consumed: false,
    };
    const boosted = (container: HTMLElement) =>
      (container.firstElementChild as HTMLElement).className.includes("brightness-[1.9]");

    // The boost lifts the near-black chip off the light grey panel; a bare badge sits on a dark well and keeps its art.
    it("is brightened on its panel and drawn as it is when bare", () => {
      const panel = render(<ResourceIcon resource={circuit} tooltip={false} />);
      expect(boosted(panel.container)).toBe(true);
      panel.unmount();
      const bare = render(<ResourceIcon resource={circuit} bare tooltip={false} />);
      expect(boosted(bare.container)).toBe(false);
    });
  });

  describe("where an icon may come from", () => {
    // The dataset still ships unresolved `asset:` hints for some aspects, and a
    // served recipe never passes the plan schema: the site's own art only.
    it("draws the bundled aspect art for an aspect whose icon is an unresolved asset hint", () => {
      const { container } = render(
        <ResourceIcon
          resource={{
            kind: "aspect",
            id: "thaumcraft:aspect:ignis",
            amount: 1,
            displayName: "Ignis",
            iconPath: "asset:gregtech:textures/aspects/IGNIS.png",
          }}
          tooltip={false}
        />,
      );
      const sources = [...container.querySelectorAll("[style]")].map((el) => (el as HTMLElement).style.maskImage);
      expect(sources.some((value) => value.includes("/nei/thaumcraft/aspects/ignis.png"))).toBe(true);
      expect(container.innerHTML).not.toContain("asset:");
    });

    it("never puts an outside address or an asset hint into an img or an atlas", () => {
      const { container } = render(
        <>
          <ResourceIcon
            resource={{ kind: "item", id: "x", amount: 1, displayName: "X", iconPath: "https://evil.example/x.png" }}
            tooltip={false}
          />
          <ResourceIcon
            resource={{
              kind: "item",
              id: "y",
              amount: 1,
              displayName: "Y",
              iconAtlas: { imagePath: "https://evil.example/a.png", atlasWidth: 1, atlasHeight: 1, x: 0, y: 0, width: 1, height: 1 },
            }}
            tooltip={false}
          />
          <ResourceIcon
            resource={{ kind: "item", id: "z", amount: 1, displayName: "Z", iconPath: "/nei/test/z.png" }}
            tooltip={false}
          />
        </>,
      );
      expect(container.innerHTML).not.toContain("evil.example");
      expect([...container.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(["/nei/test/z.png"]);
    });
  });

  describe("fluids", () => {
    // Older plans and custom fluids can have no artwork; they still need a face.
    function renderFluid(id: string, displayName: string, dominantColor?: string) {
      return render(
        <ResourceIcon
          resource={{ kind: "fluid", id, amount: 1, displayName, dominantColor }}
          tooltip={false}
        />,
      );
    }

    it("draws something for a fluid with no icon at all", () => {
      renderFluid("ic2distilledwater", "Distilled Water");
      expect(screen.getByRole("img", { name: "Distilled Water" })).toBeDefined();
    });

    it("prefers the dataset colour when one exists", () => {
      const { container } = renderFluid("some_fluid", "Some Fluid", "#123456");
      const fill = container.querySelector<HTMLElement>('[role="img"] > span');
      expect(fill?.style.backgroundColor).toBe("rgb(18, 52, 86)");
    });

    it("gives the same fluid the same colour every time", () => {
      // A fluid that changed colour between renders — or between the canvas and
      // this panel — would read as a different resource.
      const first = renderFluid("gt_unknown_fluid", "Unknown");
      const firstColor = first.container.querySelector<HTMLElement>('[role="img"] > span')?.style
        .backgroundColor;
      cleanup();

      const second = renderFluid("gt_unknown_fluid", "Unknown");
      const secondColor = second.container.querySelector<HTMLElement>('[role="img"] > span')?.style
        .backgroundColor;

      expect(firstColor).toBeTruthy();
      expect(secondColor).toBe(firstColor);
    });

    it("gives different fluids different colours", () => {
      const first = renderFluid("fluid_alpha", "Alpha");
      const firstColor = first.container.querySelector<HTMLElement>('[role="img"] > span')?.style
        .backgroundColor;
      cleanup();

      const second = renderFluid("fluid_beta", "Beta");
      const secondColor = second.container.querySelector<HTMLElement>('[role="img"] > span')?.style
        .backgroundColor;

      expect(secondColor).not.toBe(firstColor);
    });

    it("uses the recognisable colour for well-known fluids", () => {
      const { container } = renderFluid("water", "Water");
      const fill = container.querySelector<HTMLElement>('[role="img"] > span');
      expect(fill?.style.backgroundColor).toBe("rgb(63, 118, 228)");
    });

    it("still renders real art when a fluid does have an icon", () => {
      render(
        <ResourceIcon
          resource={{
            kind: "fluid",
            id: "with_art",
            amount: 1,
            displayName: "With Art",
            iconPath: "/datasets/gtnh/v/textures/rendered/with_art.png",
          }}
          tooltip={false}
        />,
      );
      expect(screen.getByAltText("With Art")).toBeDefined();
    });
  });

  it("hides generated bee species internals from tooltips", async () => {
    render(
      <ResourceIcon
        resource={{
          kind: "item",
          id: "factoryflow:bee_species:gregtech-explosive",
          amount: 1,
          displayName: "Explosive Bee",
          iconPath: "/datasets/gtnh/v/textures/rendered/explosive_bee.png",
          tooltip: [
            "Bee species",
            "gregtech.bee.speciesExplosive",
            "gregtech.common.bees.GTAlleleBeeSpecies",
          ],
          consumed: false,
        }}
      />,
    );

    fireEvent.mouseMove(screen.getByAltText("Explosive Bee").parentElement as HTMLElement, {
      clientX: 120,
      clientY: 80,
      buttons: 0,
    });

    expect(await screen.findByText("Explosive Bee")).toBeTruthy();
    expect(screen.queryByText("Bee species")).toBeNull();
    expect(screen.queryByText("gregtech.bee.speciesExplosive")).toBeNull();
    expect(screen.queryByText("gregtech.common.bees.GTAlleleBeeSpecies")).toBeNull();
    expect(screen.queryByText("Not consumed")).toBeNull();
  });

  it("waits on a sprite behind an outline instead of painting its name", async () => {
    // A loading `<img>` paints its alt text, so a panel of icons filled itself
    // with item names in a font sized for something ten times the box.
    render(
      <ResourceIcon
        resource={{
          kind: "item",
          id: "minecraft:iron_ingot",
          amount: 1,
          displayName: "Iron Ingot",
          iconPath: "/datasets/gtnh/v/textures/rendered/iron_ingot.png",
        }}
        tooltip={false}
      />,
    );

    const sprite = screen.getByAltText("Iron Ingot");
    expect(sprite.parentElement?.className).toContain("invisible");

    fireEvent.load(sprite);

    expect(sprite.parentElement?.className).not.toContain("invisible");
  });

  it("names only the item on a slot that rotates through what it accepts", async () => {
    // The group's name and every member of it, twice over, buried the one thing
    // being pointed at under eight wrapped lines.
    render(
      <ResourceIcon
        resource={{
          kind: "item",
          id: "minecraft:log",
          amount: 16,
          displayName: "Oak Log",
          iconPath: "/datasets/gtnh/v/textures/rendered/oak_log.png",
          tooltip: ["Ore dictionary: logWood", "Accepts: Oak Log, Spruce Log, Birch Log"],
          alternatives: [
            { kind: "item", id: "minecraft:log@1", displayName: "Spruce Log" },
            { kind: "item", id: "minecraft:log@2", displayName: "Birch Log" },
          ],
        }}
        alternativeState="cycling"
      />,
    );

    fireEvent.mouseMove(screen.getByAltText("Oak Log").parentElement as HTMLElement, {
      clientX: 120,
      clientY: 80,
      buttons: 0,
    });

    expect(await screen.findByText("Oak Log")).toBeTruthy();
    expect(screen.getByText("Scroll to pick one.")).toBeTruthy();
    expect(screen.queryByText(/Accepts:/)).toBeNull();
    expect(screen.queryByText(/Ore dictionary:/)).toBeNull();
  });

  it("colorizes fallback Thaumcraft aspect icons", () => {
    render(
      <ResourceIcon
        resource={{
          kind: "aspect",
          id: "thaumcraft:aspect:ignis",
          amount: 8,
          displayName: "Ignis",
        }}
        showAmount={false}
      />,
    );

    const icon = screen.getByRole("img", { name: "Ignis" });
    expect((icon.querySelector("span:last-child") as HTMLElement).style.backgroundColor).toBe(
      "rgb(255, 90, 1)",
    );
  });

  it("uses the bundled unknown aspect mask for GTNH aspects without static icons", () => {
    render(
      <ResourceIcon
        resource={{
          kind: "aspect",
          id: "thaumcraft:aspect:electrum",
          amount: 8,
          displayName: "Electrum",
          dominantColor: "#d9c35c",
        }}
        showAmount={false}
      />,
    );

    const icon = screen.getByRole("img", { name: "Electrum" });
    expect((icon.querySelector("span:last-child") as HTMLElement).style.maskImage).toContain(
      "/nei/thaumcraft/aspects/_unknown.png",
    );
  });
});
