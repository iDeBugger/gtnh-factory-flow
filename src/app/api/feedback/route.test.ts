import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_SCHEMA_VERSION } from "@/lib/model/types";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

vi.mock("@/lib/server/community", () => ({
  isCommunityConfigured: () => true,
  clientAddress: (request: Request) => request.headers.get("x-client-ip") ?? "local",
  saltedKey: (text: string) => `#${text}`,
}));
vi.mock("@/lib/server/feedback-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/feedback-guard")>();
  return { ...actual, claimIssue: vi.fn(async () => undefined) };
});
vi.mock("@/lib/server/feedback-files", () => ({
  storeFeedbackFile: vi.fn(
    async (origin: string, id: string, file: string) => `${origin}/api/feedback/files/${id}/${file}`,
  ),
  removeFeedbackFiles: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/feedback")>();
  return {
    ...actual,
    openIssue: vi.fn(async () => ({ number: 12, url: "https://github.com/jackwrichards/gtnh-planner-mod/issues/12" })),
  };
});

import { openIssue } from "@/lib/server/feedback";
import { removeFeedbackFiles, storeFeedbackFile } from "@/lib/server/feedback-files";
import { claimIssue, feedbackGate } from "@/lib/server/feedback-guard";
import { resetMemoryTokens } from "@/lib/server/memory-rate";
import { POST } from "./route";

const plan = {
  schemaVersion: PROJECT_SCHEMA_VERSION,
  id: "project-1",
  name: "Steel line",
  recipes: [],
  nodes: [],
  storages: [],
  edges: [],
  fuelProfiles: [],
};

function send(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(new Request("http://localhost/api/feedback", { method: "POST", headers, body: JSON.stringify(body) }));
}

const report = {
  kind: "idea",
  mood: "happy",
  title: "Copy a card",
  description: "Let me copy a card",
  deviceId: "gtnhplanner-0b6c1c7e-8f0a-4c43-9a51-6f2d0c1e2b3a",
  versions: { mod: "0.2.0-alpha.5", pack: "2.9.84", java: "25.0.1", os: "Windows 11 10.0" },
  plans: [{ name: "Steel line", plan }],
};

afterEach(() => {
  vi.unstubAllEnvs();
  // Every case here sends from one (absent) address: the gate's sender share would otherwise meet across them.
  feedbackGate.reset();
  resetMemoryTokens();
});

describe("the feedback route", () => {
  withModAndCommunityOn();

  it("is closed until the server has a GitHub token", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "");
    const response = await send(report);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Reports can't be sent yet." });
  });

  it("opens an issue with the plan linked and answers its page", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    const response = await send(report);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      number: 12,
      url: "https://github.com/jackwrichards/gtnh-planner-mod/issues/12",
    });
    const [token, repo, issue] = vi.mocked(openIssue).mock.calls[0]!;
    expect(token).toBe("token");
    expect(repo).toBe("jackwrichards/gtnh-planner-mod");
    expect(issue.title).toBe("Idea: Copy a card");
    expect(issue.labels).toEqual(["from game", "enhancement"]);
    expect(issue.body).toContain("[open in the planner](https://gtnhplanner.com/#p=gtnh1.");
    expect(issue.body).toMatch(/\[plan file\]\(https:\/\/gtnhplanner\.com\/api\/feedback\/files\/[0-9a-f-]{36}\/plan-1\.json\)/);
  });

  it("opens a web planner's report under the web label, and refuses its shape dressed as the game's", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    vi.mocked(openIssue).mockClear();
    const web = {
      ...report,
      origin: "web",
      deviceId: "web-0b6c1c7e-8f0a-4c43-9a51-6f2d0c1e2b3a",
      versions: { mod: "3.12.0", pack: "", java: "", os: "Win32" },
    };
    const sent = await send(web);
    expect(sent.status).toBe(201);
    expect(vi.mocked(openIssue).mock.calls[0]![2].labels).toEqual(["from web", "enhancement"]);
    // The web planner's reports open on the website's repo, the game's on the mod's.
    expect(vi.mocked(openIssue).mock.calls[0]![1]).toBe("jackwrichards/gtnh-factory-flow");
    vi.mocked(openIssue).mockClear();
    // The web's origin with the game's device id and a Java, and the game's shape claiming the web's origin.
    expect((await send({ ...web, deviceId: report.deviceId })).status).toBe(400);
    expect((await send({ ...web, versions: { ...web.versions, java: "25.0.1" } })).status).toBe(400);
    expect((await send({ ...report, origin: "web" })).status).toBe(400);
    expect(openIssue).not.toHaveBeenCalled();
  });

  it("refuses a bad report and a busy player", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    expect((await send({ ...report, title: "" })).status).toBe(400);
    vi.mocked(claimIssue).mockResolvedValueOnce({ status: 429, error: "That's a lot of reports. Try again in an hour." });
    const busy = await send(report);
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: "That's a lot of reports. Try again in an hour." });
  });

  it("the stored plan file and the link carry no comments", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    vi.mocked(openIssue).mockClear();
    vi.mocked(storeFeedbackFile).mockClear();
    const teamPlan = {
      ...plan,
      primaryView: "tasks",
      tasks: [{ id: "t1", title: "Wire it", status: "todo", order: "a", assignees: ["acct-2"], createdBy: "acct-1" }],
      taskComments: [{ id: "c1", taskId: "t1", by: "acct-2", byName: "Bob", at: "2026-01-01T00:00:00Z", text: "hi" }],
      metadata: { communityPlanId: "post-1", source: "test" },
    };
    const response = await send({ ...report, plans: [{ name: "Team line", plan: teamPlan }] });
    expect(response.status).toBe(201);
    const stored = vi.mocked(storeFeedbackFile).mock.calls.find((call) => call[2] === "plan-1.json");
    expect(stored).toBeDefined();
    const file = JSON.parse(Buffer.from(stored![3]).toString()) as Record<string, unknown>;
    expect(file).not.toHaveProperty("tasks");
    expect(file).not.toHaveProperty("taskComments");
    expect(file).not.toHaveProperty("primaryView");
    expect(file.metadata).toEqual({ source: "test" });
    expect(JSON.stringify(file)).not.toContain("acct-2");
    expect(vi.mocked(openIssue).mock.calls[0]![2].body).not.toContain("Bob");
  });

  it("a GitHub refusal removes what was stored", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    vi.mocked(removeFeedbackFiles).mockClear();
    vi.mocked(openIssue).mockRejectedValueOnce(new Error("GitHub answered 502"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refused = await send(report);
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: "The report could not be sent. Try again later." });
    expect(removeFeedbackFiles).toHaveBeenCalledTimes(1);
    const [id, files] = vi.mocked(removeFeedbackFiles).mock.calls[0]!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(files).toEqual(["plan-1.json"]);

    vi.mocked(removeFeedbackFiles).mockClear();
    vi.mocked(openIssue).mockRejectedValueOnce(new Error("GitHub answered 502"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString("base64");
    expect((await send({ ...report, picture: png })).status).toBe(502);
    expect(vi.mocked(removeFeedbackFiles).mock.calls[0]![1]).toEqual(["plan-1.json", "picture.png"]);
  });

  it("pauses nothing for one address's bad reports", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    vi.mocked(openIssue).mockClear();
    for (let i = 0; i < 70; i++) {
      const response = await send({ ...report, title: "" }, { "x-client-ip": "10.0.0.1" });
      expect([400, 429]).toContain(response.status);
    }
    // Past its share, the one address is told so; the box stays open to everyone else.
    const held = await send(report, { "x-client-ip": "10.0.0.1" });
    expect(held.status).toBe(429);
    expect(await held.json()).toEqual({ error: "That's a lot of reports. Slow down." });
    const other = await send(report, { "x-client-ip": "10.0.0.2" });
    expect(other.status).toBe(201);
    expect(openIssue).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for a report the game did not send, before any count", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    vi.mocked(openIssue).mockClear();
    vi.mocked(claimIssue).mockClear();
    const forged = await send({ ...report, versions: { mod: "1", pack: "1", java: "1", os: "Windows 10" } });
    expect(forged.status).toBe(400);
    expect(await send({ ...report, deviceId: "device" })).toHaveProperty("status", 400);
    expect(claimIssue).not.toHaveBeenCalled();
    expect(openIssue).not.toHaveBeenCalled();
  });
});

describe("the feedback route with the setting unset", () => {
  withModAndCommunityUnset();

  it("answers the game's reports, with or without their origin, as absent, before any count", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    vi.mocked(openIssue).mockClear();
    vi.mocked(claimIssue).mockClear();
    for (const body of [report, { ...report, origin: "game" }]) {
      const response = await send(body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
    expect(claimIssue).not.toHaveBeenCalled();
    expect(openIssue).not.toHaveBeenCalled();
  });

  it("answers a game report as absent ahead of the server's readiness", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "");
    const response = await send(report);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("stops reading a body with no length at the cap", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    vi.mocked(claimIssue).mockClear();
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 64) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const response = await POST(
      new Request("http://localhost/api/feedback", { method: "POST", body, duplex: "half" } as RequestInit),
    );
    expect(response.status).toBe(413);
    // Four megabytes and one chunk past it, not the whole 64.
    expect(sent).toBeLessThan(10);
    expect(claimIssue).not.toHaveBeenCalled();
  });

  it("opens the web planner's reports as before", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_TOKEN", "token");
    vi.mocked(openIssue).mockClear();
    const web = {
      ...report,
      origin: "web",
      deviceId: "web-0b6c1c7e-8f0a-4c43-9a51-6f2d0c1e2b3a",
      versions: { mod: "3.12.0", pack: "", java: "", os: "Win32" },
    };
    const sent = await send(web);
    expect(sent.status).toBe(201);
    expect(vi.mocked(openIssue).mock.calls[0]![1]).toBe("jackwrichards/gtnh-factory-flow");
    expect((await send({ ...web, title: "" })).status).toBe(400);
  });
});
