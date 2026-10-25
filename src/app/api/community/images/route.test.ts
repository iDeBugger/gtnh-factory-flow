import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { getCommunityDb } from "@/lib/server/db";
import {
  forgetImageCapWarnings,
  IMAGES_PER_DAY,
  IMAGES_PER_HOUR,
  SITE_IMAGES_PER_HOUR,
} from "@/lib/server/limits/image-upload-guard";
import { withModAndCommunityUnset } from "@/test-support/mod-and-community";
import { countedBody } from "@/test-support/request-bodies";
import { POST } from "./route";
import { GET } from "./[month]/[name]/route";

/**
 * Board image uploads against the local database: open to anyone with the
 * community switched off, limited by address whatever the client sends, and
 * capped for the whole site.
 */

let local: LocalDatabase;
let files: string;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function upload(address: string, body: Uint8Array = PNG, deviceId?: string): Promise<Response> {
  const form = new FormData();
  form.set("image", new Blob([body as BlobPart], { type: "image/png" }), "board.png");
  if (deviceId) {
    form.set("deviceId", deviceId);
  }
  return POST(
    new Request("http://localhost/api/community/images", {
      method: "POST",
      headers: { "x-client-ip": address },
      body: form,
    }),
  );
}

async function uploadsRecorded(): Promise<number> {
  const { count } = await getCommunityDb()
    .from("community_events")
    .select("id", { count: "exact", head: true })
    .eq("action", "image_upload");
  return count ?? 0;
}

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "images-test-salt");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stage.gtnhplanner.idebugger.net");
  files = mkdtempSync(path.join(tmpdir(), "images-route-"));
  vi.stubEnv("FILE_STORE_DIR", files);
  local = await openLocalDatabase();
  useInProcessLocalDb(local.handle);
}, 60_000);

afterAll(async () => {
  useInProcessLocalDb(undefined);
  await local?.close();
  vi.unstubAllEnvs();
  rmSync(files, { recursive: true, force: true });
});

beforeEach(async () => {
  await local.db.exec("delete from community_events");
  forgetImageCapWarnings();
});

describe("board image uploads", () => {
  withModAndCommunityUnset();

  it("serves a board image with the setting unset, at a URL on this site", async () => {
    const response = await upload("203.0.113.1");
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const match = /^https:\/\/stage\.gtnhplanner\.idebugger\.net\/api\/community\/images\/(\d{4}-\d{2})\/([0-9a-f]{18}\.png)$/.exec(
      url,
    );
    expect(match, url).not.toBeNull();
    const [, month, name] = match!;
    const served = await GET(new Request(url), { params: Promise.resolve({ month: month!, name: name! }) });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("refuses an oversize upload before the body is buffered or counted", async () => {
    // A 5 MiB multipart part around a real PNG header: over the cap by its total, not by any field.
    const padded = new Uint8Array(5 * 1024 * 1024);
    padded.set(PNG);
    const refused = await upload("203.0.113.2", padded);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ error: "That image is too big: the limit is 4 MB." });
    expect(await uploadsRecorded()).toBe(0);

    // A declared length over the cap is refused before a byte is read.
    const { body, counts } = countedBody(new Uint8Array(1024 * 1024), 64);
    const unread = await POST(
      new Request("http://localhost/api/community/images", {
        method: "POST",
        headers: {
          "x-client-ip": "203.0.113.2",
          "content-length": String(64 * 1024 * 1024),
          "content-type": "multipart/form-data; boundary=x",
        },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(unread.status).toBe(413);
    expect(counts.pulls).toBe(0);

    // The capped re-parse keeps the file: a 100 KB picture still lands.
    const picture = new Uint8Array(100 * 1024);
    picture.set(PNG);
    const stored = await upload("203.0.113.2", picture);
    expect(stored.status).toBe(200);
    expect(await uploadsRecorded()).toBeGreaterThan(0);
  });

  it("holds one address to 30 an hour whatever device id it sends", async () => {
    for (let i = 0; i < IMAGES_PER_HOUR; i++) {
      expect((await upload("203.0.113.10", PNG, `device-${i}`)).status).toBe(200);
    }
    const refused = await upload("203.0.113.10", PNG, "device-fresh");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Too many image uploads: try again in a little while." });
    expect((await upload("203.0.113.11")).status).toBe(200);
  });

  it("holds one address to 60 a day", async () => {
    // An hour passes: every count so far is two hours old, the day's still counts.
    const hourPasses = async () => {
      const twoHoursBack = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { error } = await getCommunityDb()
        .from("community_events")
        .update({ created_at: twoHoursBack })
        .eq("action", "image_upload");
      expect(error).toBeNull();
    };
    for (let i = 0; i < IMAGES_PER_HOUR; i++) {
      expect((await upload("203.0.113.20")).status).toBe(200);
    }
    await hourPasses();
    for (let i = IMAGES_PER_HOUR; i < IMAGES_PER_DAY; i++) {
      expect((await upload("203.0.113.20")).status).toBe(200);
    }
    await hourPasses();
    const refused = await upload("203.0.113.20");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "That is a lot of images for one day. Try again tomorrow." });
  }, 60_000);

  it("caps the whole site, says when it opens again, and tells the log", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < SITE_IMAGES_PER_HOUR; i++) {
      expect((await upload(`198.51.${Math.floor(i / 200)}.${i % 200}`)).status).toBe(200);
    }
    expect(warned).not.toHaveBeenCalled();
    const refused = await upload("198.51.100.250");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: "Lots of images are being uploaded right now. Try again in an hour.",
    });
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0]![0])).toContain(`${SITE_IMAGES_PER_HOUR} an hour`);
    // Refused again within the hour: one line in the log for the window, not one per refusal.
    expect((await upload("198.51.100.251")).status).toBe(503);
    expect((await upload("198.51.100.252")).status).toBe(503);
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  }, 60_000);

  it("refuses what is not an image before counting it", async () => {
    const refused = await upload("203.0.113.30", new TextEncoder().encode("not a picture, just words"));
    expect(refused.status).toBe(415);
    expect(await uploadsRecorded()).toBe(0);
  });
});
