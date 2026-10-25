import { beforeEach, describe, expect, it, vi } from "vitest";
import { oversizeRequest } from "@/test-support/request-bodies";

const bumpSessionEpoch = vi.fn(async (_id: string) => undefined);
vi.mock("@/lib/server/community", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/community")>();
  return {
    ...actual,
    getSessionUser: vi.fn(async () => ({ id: "u1", username: "ann" })),
    bumpSessionEpoch: (id: string) => bumpSessionEpoch(id),
  };
});
vi.mock("@/lib/server/cloud-plans", () => ({ notifyLive: vi.fn(async () => true) }));

import { POST } from "./route";

const post = (body: string) =>
  POST(new Request("http://localhost/api/community/auth/logout", { method: "POST", body }));

describe("sign out", () => {
  beforeEach(() => {
    bumpSessionEpoch.mockClear();
  });

  it("ends every session on { everywhere: true } and clears the cookie", async () => {
    const answer = await post(JSON.stringify({ everywhere: true }));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("set-cookie")).toContain("gtnh_session=");
    expect(bumpSessionEpoch).toHaveBeenCalledWith("u1");
  });

  it("reads a body over the small cap as a plain sign-out, without reading it", async () => {
    const { request, counts } = oversizeRequest("http://localhost/api/community/auth/logout", "POST", 9 * 1024 * 1024);
    const answer = await POST(request);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("set-cookie")).toContain("gtnh_session=");
    expect(counts.pulls).toBe(0);
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
  });

  it("reads no body, or one that is not JSON, as a plain sign-out", async () => {
    for (const body of ["", "not json", "null"]) {
      const answer = await post(body);
      expect(answer.status).toBe(200);
    }
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
  });
});
