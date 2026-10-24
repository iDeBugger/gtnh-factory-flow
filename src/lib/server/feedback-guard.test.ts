import { beforeEach, describe, expect, it, vi } from "vitest";

/** community_events as a list: the guard's counts read what its records wrote. */
const events: { actorKey: string; action: string }[] = [];

vi.mock("./community", () => ({
  clientAddress: (request: Request) => request.headers.get("x-client-ip") ?? "local",
  saltedKey: (text: string) => `#${text}`,
  countEvents: vi.fn(async (actorKey: string, action: string) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return events.filter((e) => e.actorKey === actorKey && e.action === action).length;
  }),
  recordEvents: vi.fn(async (list: { actorKey: string; action: string }[]) => {
    events.push(...list);
  }),
}));

import type { FeedbackReport } from "./feedback";
import { resetMemoryTokens } from "./memory-rate";
import {
  ARRIVALS_PER_MINUTE,
  claimIssue,
  FeedbackGate,
  FLOOD_REFUSALS,
  FLOOD_REFUSALS_PER_ADDRESS,
  SENDER_ARRIVALS_PER_MINUTE,
  looksGenuine,
  looksSentByTheGame,
  looksSentByTheWeb,
  PAUSE_MS,
  PER_SENDER_DAY,
  PER_SENDER_HOUR,
  SITE_PER_DAY,
  SITE_PER_HOUR,
  WEB_PER_SENDER_DAY,
  WEB_PER_SENDER_HOUR,
  WEB_SITE_PER_HOUR,
  wordsOf,
} from "./feedback-guard";

const DEVICE = "gtnhplanner-0b6c1c7e-8f0a-4c43-9a51-6f2d0c1e2b3a";

function report(
  overrides: Partial<FeedbackReport> = {},
  versions: Partial<FeedbackReport["versions"]> = {},
): FeedbackReport {
  return {
    kind: "bug",
    title: "Wires vanish",
    description: "After Arrange the wires vanish.",
    deviceId: DEVICE,
    versions: {
      mod: "0.2.0-alpha.5",
      pack: "2.9.84",
      java: "25.0.1",
      os: "Windows 11 10.0",
      ...versions,
    },
    plans: [],
    ...overrides,
  };
}

function from(address: string): Request {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { "x-client-ip": address },
  });
}

beforeEach(() => {
  events.length = 0;
  resetMemoryTokens();
});

describe("what a report from the game looks like", () => {
  it("takes the versions real players sent", () => {
    for (const versions of [
      { mod: "0.2.0-alpha.2-main.3+7736a2234d", pack: "", java: "25.0.4.1", os: "Windows 11 10.0" },
      {
        mod: "0.2.0-alpha.4",
        pack: "2.9.84",
        java: "26.0.2",
        os: "Linux 6.16.12-valve24.5-1-neptune-616-gb2f7cfe85e45",
      },
      { mod: "0.2.0-alpha.4", pack: "2.9.61", java: "25.0.1", os: "Linux 7.2.9-arch1-1" },
      { mod: "0.2.0-alpha.5", pack: "2.9.0-RC-2", java: "1.8.0_402", os: "Mac OS X 15.1" },
    ]) {
      expect(looksSentByTheGame(report({}, versions))).toBe(true);
    }
    expect(
      looksSentByTheGame(report({ deviceId: "plannh-0b6c1c7e-8f0a-4c43-9a51-6f2d0c1e2b3a" })),
    ).toBe(true);
  });

  it("refuses the made-up ones the flood sent", () => {
    for (const versions of [
      { mod: "1", pack: "1", java: "1", os: "Windows 10" },
      { mod: "269", pack: "521", java: "856", os: "Ubuntu" },
      { mod: "Latest, i promise ;3", pack: "", java: "The best one ever!", os: "Debian GNU/Linux" },
      { mod: "245", pack: "186", java: "431", os: "Fedora Linux 🏳️‍⚧️" },
      { mod: "", pack: "", java: "", os: "" },
    ]) {
      expect(looksSentByTheGame(report({}, versions))).toBe(false);
    }
    expect(looksSentByTheGame(report({ deviceId: "device" }))).toBe(false);
    expect(looksSentByTheGame(report({ deviceId: "gtnhplanner-anything" }))).toBe(false);
  });

  it("compares words, not case, spacing or punctuation", () => {
    expect(wordsOf(report({ title: "Unplug  ALL clankers!!", description: "" }))).toBe(
      wordsOf(report({ title: "unplug all clankers", description: " " })),
    );
    expect(wordsOf(report({ title: "a" }))).not.toBe(wordsOf(report({ title: "b" })));
  });
});

const WEB_DEVICE = "web-0b6c1c7e-8f0a-4c43-9a51-6f2d0c1e2b3a";

function webReport(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return report({
    origin: "web",
    deviceId: WEB_DEVICE,
    versions: { mod: "3.12.0", pack: "", java: "", os: "Win32" },
    ...overrides,
  });
}

describe("what a report from the web planner looks like", () => {
  it("is its own origin with its own shapes, not a game's", () => {
    expect(looksSentByTheWeb(webReport())).toBe(true);
    expect(looksGenuine(webReport())).toBe(true);
    expect(looksSentByTheGame(webReport())).toBe(false);
  });

  it("is refused with the game's shapes, a Java, a log or a missing origin", () => {
    expect(looksSentByTheWeb(webReport({ origin: undefined }))).toBe(false);
    expect(looksSentByTheWeb(webReport({ deviceId: DEVICE }))).toBe(false);
    expect(looksSentByTheWeb(webReport({ versions: { mod: "3.12.0", pack: "2.9.0", java: "", os: "Win32" } }))).toBe(false);
    expect(looksSentByTheWeb(webReport({ versions: { mod: "3.12.0", pack: "", java: "25.0.1", os: "Win32" } }))).toBe(false);
    expect(looksSentByTheWeb(webReport({ log: "lines" }))).toBe(false);
    expect(looksSentByTheWeb(webReport({ crash: "trace" }))).toBe(false);
    expect(looksGenuine(webReport({ deviceId: "anything" }))).toBe(false);
  });

  it("does not let a game-shaped report claim to be the web's, nor the web's pass as the game's", () => {
    expect(looksGenuine(report())).toBe(true);
    expect(looksGenuine(report({ origin: "web" }))).toBe(false);
  });
});

describe("the gate", () => {
  it("takes a minute's share, then is busy until the minute is past", () => {
    let now = 0;
    const gate = new FeedbackGate(() => now);
    // The site's share is spread over senders, each within their own.
    const senders = Math.ceil(ARRIVALS_PER_MINUTE / SENDER_ARRIVALS_PER_MINUTE);
    for (let i = 0; i < ARRIVALS_PER_MINUTE; i++) {
      expect(gate.admit(`s${i % senders}`)).toBe("open");
    }
    expect(gate.admit("someone else")).toBe("busy");
    now = 60_000;
    expect(gate.admit("someone else")).toBe("open");
  });

  it("pauses reports after a flood of refusals, for hours", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 0;
    const gate = new FeedbackGate(() => now);
    // Sixty refusals as twenty senders with three each; the last one tips it.
    for (let i = 0; i < FLOOD_REFUSALS - 1; i++) {
      gate.refused(`s${Math.floor(i / FLOOD_REFUSALS_PER_ADDRESS)}`);
    }
    expect(gate.admit("x")).toBe("open");
    gate.refused(`s${Math.floor((FLOOD_REFUSALS - 1) / FLOOD_REFUSALS_PER_ADDRESS)}`);
    expect(gate.admit("x")).toBe("paused");
    now = PAUSE_MS - 1;
    expect(gate.admit("x")).toBe("paused");
    now = PAUSE_MS;
    expect(gate.admit("x")).toBe("open");
  });

  it("does not pause for one address's refusals", () => {
    const gate = new FeedbackGate(() => 0);
    for (let i = 0; i < 200; i++) {
      gate.refused("a");
    }
    expect(gate.admit("b")).toBe("open");
  });

  it("counts each address at most three times toward a flood", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gate = new FeedbackGate(() => 0);
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < 20; i++) {
        gate.refused(`many${s}`);
      }
    }
    expect(gate.admit("z")).toBe("open");
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < FLOOD_REFUSALS_PER_ADDRESS; i++) {
        gate.refused(`more${s}`);
      }
    }
    expect(gate.admit("z")).toBe("paused");
  });

  it("gives one address a few arrivals a minute, and the site its own share", () => {
    let now = 0;
    const gate = new FeedbackGate(() => now);
    for (let i = 0; i < SENDER_ARRIVALS_PER_MINUTE; i++) {
      expect(gate.admit("a")).toBe("open");
    }
    expect(gate.admit("a")).toBe("sender");
    expect(gate.admit("b")).toBe("open");
    now = 60_000;
    expect(gate.admit("a")).toBe("open");
  });
});

describe("claiming an issue from the web planner", () => {
  it("allows fewer a sender than the game does", async () => {
    expect(WEB_PER_SENDER_HOUR).toBeLessThan(PER_SENDER_HOUR);
    expect(WEB_PER_SENDER_DAY).toBeLessThan(PER_SENDER_DAY);
    for (let i = 0; i < WEB_PER_SENDER_HOUR; i++) {
      expect(await claimIssue(from("5.5.5.5"), webReport({ title: `web report ${i}` }))).toBeUndefined();
    }
    expect((await claimIssue(from("5.5.5.5"), webReport({ title: "one too many" })))?.status).toBe(429);
    // The same address still has a game's share left: three an hour, two taken.
    expect(await claimIssue(from("5.5.5.5"), report({ title: "from the game" }))).toBeUndefined();
  });

  it("records the web's own site count, and caps the web's share of the site", async () => {
    await claimIssue(from("6.6.6.6"), webReport({ title: "first" }));
    expect(events.some((e) => e.actorKey === "feedback:site:web")).toBe(true);
    const hex = (i: number) => i.toString(16).padStart(12, "0");
    let refused = 0;
    for (let i = 0; i < WEB_SITE_PER_HOUR + 3; i++) {
      const r = await claimIssue(
        from(`11.0.0.${i}`),
        webReport({ title: `web ${i}`, deviceId: `web-00000000-0000-4000-8000-${hex(i)}` }),
      );
      if (r) {
        expect(r.status).toBe(503);
        refused++;
      }
    }
    // One was taken above; the cap is on the web's, not the game's.
    expect(refused).toBe(4);
    expect(await claimIssue(from("12.0.0.1"), report({ title: "a game report still opens" }))).toBeUndefined();
  });

  it("does not count a game's report against the web's share", async () => {
    await claimIssue(from("7.7.7.7"), report({ title: "game" }));
    expect(events.some((e) => e.actorKey === "feedback:site:web")).toBe(false);
  });
});

describe("claiming an issue", () => {
  it("records the report against its address, device, words and the site", async () => {
    expect(await claimIssue(from("1.2.3.4"), report())).toBeUndefined();
    expect(events.map((e) => e.actorKey.split(":")[1])).toEqual([
      "address",
      "device",
      "site",
      "words",
    ]);
  });

  it("takes the same words once, even sent at the same moment from elsewhere", async () => {
    const [a, b] = await Promise.all([
      claimIssue(from("1.1.1.1"), report({ deviceId: DEVICE })),
      claimIssue(
        from("2.2.2.2"),
        report({ deviceId: DEVICE.replace("0b6c", "1111"), kind: "idea" }),
      ),
    ]);
    expect(a).toBeUndefined();
    expect(b).toEqual({ status: 409, error: "That report was sent already." });
  });

  it("limits each address and each device", async () => {
    for (let i = 0; i < PER_SENDER_HOUR; i++) {
      expect(await claimIssue(from("1.1.1.1"), report({ title: `report ${i}` }))).toBeUndefined();
    }
    expect(
      (await claimIssue(from("9.9.9.9"), report({ title: "another device's?" })))?.status,
    ).toBe(429);
    const otherDevice = DEVICE.replace("0b6c", "2222");
    expect(
      (await claimIssue(from("1.1.1.1"), report({ title: "same address", deviceId: otherDevice })))
        ?.status,
    ).toBe(429);
    expect(
      await claimIssue(from("9.9.9.9"), report({ title: "both new", deviceId: otherDevice })),
    ).toBeUndefined();
    expect(PER_SENDER_DAY).toBeGreaterThan(PER_SENDER_HOUR);
  });

  it("opens a few issues an hour for the whole site, whoever sends them", async () => {
    const hex = (i: number) => i.toString(16).padStart(12, "0");
    let refused = 0;
    for (let i = 0; i < SITE_PER_HOUR + 5; i++) {
      const r = await claimIssue(
        from(`10.0.${Math.floor(i / 250)}.${i % 250}`),
        report({ title: `report ${i}`, deviceId: `gtnhplanner-00000000-0000-4000-8000-${hex(i)}` }),
      );
      if (r) {
        expect(r.status).toBe(503);
        refused++;
      }
    }
    expect(refused).toBe(5);
    expect(SITE_PER_DAY).toBeGreaterThan(SITE_PER_HOUR);
  });
});
