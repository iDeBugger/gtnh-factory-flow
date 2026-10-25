import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyLive } from "./live-notify";

/** Notices to the live service when it does not answer at first. */

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  vi.unstubAllEnvs();
});

/** A stand-in live service answering each notice with the next status given. */
async function serviceAnswering(statuses: number[]): Promise<string[]> {
  const heard: string[] = [];
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      heard.push(`${req.url} ${text}`);
      res.writeHead(statuses.shift() ?? 200).end("{}");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("LIVE_INTERNAL_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv("LIVE_INTERNAL_TOKEN", "secret");
  return heard;
}

const notice = {
  kind: "members" as const,
  ownerId: "11111111-1111-4111-8111-111111111111",
  designId: "design-abc1",
  members: [],
};

describe("notices to the live service", () => {
  it("are tried again in the background until the service takes them", async () => {
    const heard = await serviceAnswering([503, 502, 200]);
    expect(await notifyLive(notice, [20, 20, 20])).toBe(false);
    await expect.poll(() => heard.length).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard).toHaveLength(3);
  });

  it("are not tried again when the service refuses them", async () => {
    const heard = await serviceAnswering([401]);
    expect(await notifyLive(notice, [20])).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard).toHaveLength(1);
  });

  it("go once when taken", async () => {
    const heard = await serviceAnswering([200]);
    expect(await notifyLive(notice, [20])).toBe(true);
    expect(heard).toEqual([
      '/internal/members {"doc":"11111111-1111-4111-8111-111111111111:design-abc1","members":[]}',
    ]);
  });
});
