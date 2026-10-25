// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommunityPlanStats } from "@/lib/community/types";
import { ExportFooter } from "./ExportFooter";

const stats: CommunityPlanStats = {
  nodeCount: 3,
  storageCount: 0,
  edgeCount: 2,
  machineCount: 4,
  totalEuT: 120,
  highestTierIndex: 1,
  needs: [],
  outputs: [],
};

function footer() {
  return render(
    <ExportFooter planName="Steel line" stats={stats} tone="dark" width={900} showTitle showIo={false} needs={[]} outputs={[]} />,
  ).container;
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("the exported image's footer", () => {
  it("prints the site's own host beside the numbers", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stage.gtnhplanner.idebugger.net");
    const text = footer().textContent ?? "";
    expect(text).toContain("stage.gtnhplanner.idebugger.net");
    expect(text).not.toContain("gtnhplanner.com");
  });

  it("prints no address when the site's URL is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    const text = footer().textContent ?? "";
    expect(text).toContain("4 machines");
    expect(text).not.toMatch(/gtnhplanner|localhost/);
  });
});
