// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatasetManifest, DatasetVersion, RecipeDataset } from "@/lib/datasets/types";
import { PROJECT_SCHEMA_VERSION } from "@/lib/model/types";
import { useFactoryStore } from "@/store/factory-store";
import { ResourceIndexPane } from "./ResourceIndexPane";

const datasetVersion: DatasetVersion = {
  id: "pane-version",
  gtnhVersion: "2.9.0",
  channel: "daily",
  publishedAt: "2026-05-25T00:00:00.000Z",
  manifestPath: "manifest.json",
  recipeDatasetPath: "recipes.json",
  sourceInfo: { sourceId: "recex", generatedAt: "2026-05-25T00:00:00.000Z" },
};

type Answer = {
  resources: Array<{ kind: string; id: string; displayName: string; iconPath: string }>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

// Every query answers at once except the held ones, which wait for `release`.
const loader = vi.hoisted(() => ({
  held: new Set<string>(),
  pending: [] as Array<{ query: string; resolve: () => void }>,
}));

vi.mock("@/lib/datasets/browser-loader", () => ({
  queryRecipeDatasetResources: vi.fn(
    (_url: string, _version: unknown, request: { query: string }) =>
      new Promise<Answer>((resolve) => {
        const done = () => resolve(answerFor(request.query));
        if (loader.held.has(request.query)) {
          loader.pending.push({ query: request.query, resolve: done });
        } else {
          done();
        }
      }),
  ),
}));

function answerFor(query: string): Answer {
  const name = query === "" ? "Stone" : `${query} ingot`;
  return {
    resources: [{ kind: "item", id: `test:${name}`, displayName: name, iconPath: "/x.png" }],
    total: 1,
    offset: 0,
    limit: 120,
    hasMore: false,
  };
}

async function release(query: string) {
  loader.held.delete(query);
  const entries = loader.pending.filter((entry) => entry.query === query);
  loader.pending = loader.pending.filter((entry) => entry.query !== query);
  await act(async () => entries.forEach((entry) => entry.resolve()));
}

function Pane() {
  const [search, setSearch] = useState("");
  return <ResourceIndexPane search={search} onSearchChange={setSearch} onBrowse={() => {}} />;
}

describe("ResourceIndexPane", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    loader.pending = [];
    loader.held.clear();
  });

  beforeEach(() => {
    class TestResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const manifest: DatasetManifest = {
      schemaVersion: 1,
      latestDailyVersion: datasetVersion.id,
      versions: [datasetVersion],
    };
    useFactoryStore.getState().setProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: "pane-test",
      name: "Pane test",
      fuelProfiles: [],
      recipes: [],
      nodes: [],
      edges: [],
    });
    useFactoryStore.getState().setDatasetManifest(manifest, "/datasets/manifest.json");
    useFactoryStore.getState().setDataset({
      datasetVersionId: datasetVersion.id,
      gtnhVersion: datasetVersion.gtnhVersion,
      resources: [],
      recipes: [],
    } as unknown as RecipeDataset);
  });

  it("dims the old list and marks it busy from the first key until the new answer lands", async () => {
    loader.held.add("electrum");
    render(<Pane />);
    await screen.findByLabelText("Stone");
    const grid = screen.getByRole("listbox", { name: "Resource results" });
    await waitFor(() => expect(grid.getAttribute("aria-busy")).toBeNull());
    expect(grid.hasAttribute("data-stale")).toBe(false);

    fireEvent.change(screen.getByLabelText("Search items and fluids"), {
      target: { value: "electrum" },
    });
    // Typed, not yet asked (the debounce): the old slots are an older answer already.
    const typed = screen.getByRole("listbox", { name: "Resource results" });
    expect(typed.getAttribute("aria-busy")).toBe("true");
    expect(typed.hasAttribute("data-stale")).toBe(true);
    expect(screen.getByLabelText("Stone")).toBeTruthy();

    // Asked and still on its way.
    await waitFor(() => expect(loader.pending.some((entry) => entry.query === "electrum")).toBe(true));
    expect(
      screen.getByRole("listbox", { name: "Resource results" }).getAttribute("aria-busy"),
    ).toBe("true");

    await release("electrum");
    const landed = await screen.findByLabelText("electrum ingot");
    expect(landed).toBeTruthy();
    const fresh = screen.getByRole("listbox", { name: "Resource results" });
    expect(fresh.getAttribute("aria-busy")).toBeNull();
    expect(fresh.hasAttribute("data-stale")).toBe(false);
  });
});
