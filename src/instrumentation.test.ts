import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkServerSetup = vi.fn<() => void>();
vi.mock("@/lib/server/startup-checks", () => ({
  checkServerSetup: () => checkServerSetup(),
}));

/**
 * A startup check that throws must end the process: a throw left inside
 * `register()` keeps the port bound and answers 500 to everything, which a
 * restart policy never notices.
 */
describe("the server's register hook", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("GTNH_PREWARM_ON_STARTUP", undefined);
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    checkServerSetup.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exits the process when a startup check throws", async () => {
    checkServerSetup.mockImplementation(() => {
      throw new Error("nope");
    });
    const { register } = await import("./instrumentation");
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("nope");
  });

  it("carries on when the checks pass", async () => {
    const { register } = await import("./instrumentation");
    await expect(register()).resolves.toBeUndefined();
    expect(checkServerSetup).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
