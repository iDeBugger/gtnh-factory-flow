import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkServerSetupOrExit = vi.fn<() => void>();
vi.mock("@/lib/server/startup-checks", () => ({
  checkServerSetupOrExit: () => checkServerSetupOrExit(),
}));

/** The Node.js server runs the exiting form of the checks before anything else, once. */
describe("the server's register hook", () => {
  beforeEach(() => {
    vi.stubEnv("GTNH_PREWARM_ON_STARTUP", undefined);
    checkServerSetupOrExit.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs the exiting checks on the Node.js runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
    expect(checkServerSetupOrExit).toHaveBeenCalledTimes(1);
  });

  it("does nothing on the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { register } = await import("./instrumentation");
    await register();
    expect(checkServerSetupOrExit).not.toHaveBeenCalled();
  });
});
