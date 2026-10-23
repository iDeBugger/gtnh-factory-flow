// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangelogDialog } from "@/components/ChangelogDialog";
import { CHANGELOG, visibleChangelog, type ChangelogEntry } from "@/lib/changelog";
import { unseenEntries } from "@/lib/whats-new";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";

const NOTES_READ_KEY = "gtnh-factory-flow.changelog-read.v1";

/** Copy that only makes sense with the mod or the community library on. */
const SWITCHED_OFF_COPY = [
  "Community library",
  "Post a copy to Community",
  "Browse Community",
  "Get the mod",
  "the in-game planner",
  "Open in the game",
];

/**
 * Words that mark a line as being about the mod or the community library. A
 * line that matches must be tagged, unless it is one of the passing mentions
 * below, which say nothing about either feature.
 */
const ABOUT_THEM =
  /[Uu]pvot|\b[Vv]ot(e|es|ed|ing)\b|[Pp]ublic (setup|pocket|row)|[Ss]hared setup|view-only|[Cc]ommunity|the mod\b|in-game planner|Open in the game|running game|added in the game|\b[Pp]ost(s|ed)?\b|[Pp]ublish/;
const PASSING_MENTIONS = [
  "Farm numbers, checked against the community calculator",
  "the item list no longer waits on the community server when it is slow",
  "a Fluid Tank (Non-recipe), as in the mod",
];

function entryText(entry: ChangelogEntry): string[] {
  return [
    entry.headline,
    ...entry.notes,
    entry.warning ?? "",
    ...(entry.actions ?? []).map((action) => action.label),
  ];
}

const aboutThem = (line: string) => ABOUT_THEM.test(line) && !PASSING_MENTIONS.some((ok) => line.includes(ok));

afterEach(cleanup);

describe("the changelog with the mod and the community library switched off", () => {
  withModAndCommunityUnset();
  beforeEach(() => window.localStorage.clear());

  it("shows no line about them, and none of their copy", () => {
    const visible = visibleChangelog();
    expect(visible.length).toBeGreaterThan(0);
    for (const entry of visible) {
      for (const line of entryText(entry)) {
        expect(aboutThem(line), `${entry.version}: ${line}`).toBe(false);
        for (const copy of SWITCHED_OFF_COPY) expect(line).not.toContain(copy);
      }
    }
  });

  it("keeps a passing mention", () => {
    expect(visibleChangelog().some((entry) => entry.headline === PASSING_MENTIONS[0])).toBe(true);
  });

  it("keeps a release's other notes, under a headline that does not name the mod", () => {
    const v4 = visibleChangelog().find((entry) => entry.version === "4.0.0");
    const source = CHANGELOG.find((entry) => entry.version === "4.0.0")!;
    expect(v4?.headline).toBe("Version 4: a new board, and plans you edit together");
    expect(v4?.notes).toContain(
      "Build, Solve and Pool are gone: set a count, a rate or a drawer and the board works out the rest.",
    );
    expect(v4!.notes.length).toBe(source.notes.filter((note) => typeof note === "string").length);
    const shared = visibleChangelog().find((entry) => entry.version === "4.3.2");
    expect(shared?.notes).toEqual(["Plans shared with you are no longer removed from your device while the database is down."]);
  });

  it("hides a release that is only about them", () => {
    const versions = visibleChangelog().map((entry) => entry.version);
    for (const version of ["3.11.0", "3.11.1", "4.3.1", "2.53.1", "1.13.0"]) expect(versions).not.toContain(version);
  });

  it("counts a release with other notes as unread, and one only about them not at all", () => {
    // Read up to 3.10.1: 3.11.0 and 3.11.1 (the mod) would be the oldest unread, then 4.0.0.
    window.localStorage.setItem(NOTES_READ_KEY, "3.10.1");
    const unseen = unseenEntries();
    const versions = unseen.map((entry) => entry.version);
    expect(versions).toContain("4.0.0");
    expect(versions).not.toContain("3.11.0");
    expect(versions).not.toContain("3.11.1");
    for (const entry of unseen) for (const line of entryText(entry)) expect(aboutThem(line), line).toBe(false);
  });

  it("puts none of it in the dialog, full history included", () => {
    const view = render(createElement(ChangelogDialog, { onClose: () => undefined }));
    const more = view.queryByRole("button", { name: /Full history/i });
    if (more) fireEvent.click(more);
    const text = view.baseElement.textContent ?? "";
    for (const copy of SWITCHED_OFF_COPY) expect(text).not.toContain(copy);
    expect(text).toContain(PASSING_MENTIONS[0]);
    expect(text).toContain("Version 4: a new board, and plans you edit together");
  });
});

describe("the changelog with the mod and the community library switched on", () => {
  withModAndCommunityOn();

  it("shows every release and every note as written", () => {
    const visible = visibleChangelog();
    expect(visible.map((entry) => entry.version)).toEqual(CHANGELOG.map((entry) => entry.version));
    const v4 = visible.find((entry) => entry.version === "4.0.0")!;
    expect(v4.headline).toBe("Version 4: the in-game planner on the web, and plans you edit together");
    expect(v4.notes.some((note) => note.includes("Open in the game"))).toBe(true);
    expect(visible.some((entry) => entry.actions?.some((action) => action.label === "Get the mod"))).toBe(true);
  });
});

describe("the tags", () => {
  it("are on every note about the mod or the community library", () => {
    for (const release of CHANGELOG) {
      if (release.about) continue;
      const headline = release.headlineWithout ?? release.headline;
      expect(aboutThem(headline), `${release.version}: ${headline}`).toBe(false);
      for (const note of release.notes) {
        if (typeof note === "string") expect(aboutThem(note), `${release.version}: ${note}`).toBe(false);
      }
      for (const action of release.actions ?? []) expect(aboutThem(action.label), action.label).toBe(false);
    }
  });
});
