// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DatasetManifest, DatasetVersion } from "@/lib/datasets/types";
import { useFactoryStore } from "@/store/factory-store";

const convertOpenPlan = vi.hoisted(() => vi.fn(async () => true));
const pending = vi.hoisted(() => ({ now: undefined as { target: string } | undefined }));
vi.mock("@/lib/datasets/convert-action", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/datasets/convert-action")>()),
  convertOpenPlan,
  usePendingConversion: () => pending.now,
}));

import { usePlanVersionNotice } from "./PlanVersionNotice";

const version = (id: string, gtnhVersion: string) => ({ id, gtnhVersion, publishedAt: "2026-10-01T00:00:00Z" }) as DatasetVersion;
const manifest = {
  schemaVersion: 1,
  latestStableVersion: "local-2.9.0-rc-2",
  versions: [version("local-2.9.0-rc-2", "2.9.0-RC-2"), version("local-2.8.1", "2.8.1")],
} as DatasetManifest;

describe("the unserved-version notice's key", () => {
  it("Convert to GTNH 2.9 opens a converted copy of the open plan", () => {
    const before = useFactoryStore.getState().project;
    useFactoryStore.setState({ datasetManifest: manifest, project: { ...before, gameVersion: "2.8.4" } });
    try {
      const { result } = renderHook(() => usePlanVersionNotice());
      expect(result.current?.action?.label).toBe("Convert to GTNH 2.9");
      result.current?.action?.onSelect();
      expect(convertOpenPlan).toHaveBeenCalledWith("2.9");
    } finally {
      useFactoryStore.setState({ project: before, datasetManifest: undefined });
    }
  });

  it("while a conversion runs the key says Converting to GTNH 2.9... and does nothing", () => {
    const before = useFactoryStore.getState().project;
    useFactoryStore.setState({ datasetManifest: manifest, project: { ...before, gameVersion: "2.8.4" } });
    pending.now = { target: "2.9" };
    try {
      convertOpenPlan.mockClear();
      const { result } = renderHook(() => usePlanVersionNotice());
      expect(result.current?.action?.label).toBe("Converting to GTNH 2.9...");
      result.current?.action?.onSelect();
      expect(convertOpenPlan).not.toHaveBeenCalled();
    } finally {
      pending.now = undefined;
      useFactoryStore.setState({ project: before, datasetManifest: undefined });
    }
  });

  it("no key while this site does not serve GTNH 2.9", () => {
    const before = useFactoryStore.getState().project;
    useFactoryStore.setState({ datasetManifest: { ...manifest, versions: [manifest.versions[1]!] }, project: { ...before, gameVersion: "2.8.4" } });
    try {
      const { result } = renderHook(() => usePlanVersionNotice());
      expect(result.current?.text).toBeTruthy();
      expect(result.current?.action).toBeUndefined();
    } finally {
      useFactoryStore.setState({ project: before, datasetManifest: undefined });
    }
  });
});
