import { describe, expect, it } from "vitest";
import { OWNER, viewers } from "@/test-support/viewers";
import { canSeePlan, isUuid } from "./access";

describe("canSeePlan", () => {
  // Every row and viewer, with the answer written out: a published post is
  // everyone's; an unpublished one is its owner's and the admin's alone, and
  // a post whose account is gone is nobody's to own.
  const table: Array<[string, { is_public: boolean; user_id: string | null }, Record<string, boolean>]> = [
    [
      "published",
      { is_public: true, user_id: OWNER },
      {
        anonymous: true,
        owner: true,
        stranger: true,
        "admin account": true,
        "admin header": true,
        "admin header, signed in": true,
      },
    ],
    [
      "published, account gone",
      { is_public: true, user_id: null },
      {
        anonymous: true,
        owner: true,
        stranger: true,
        "admin account": true,
        "admin header": true,
        "admin header, signed in": true,
      },
    ],
    [
      "unpublished",
      { is_public: false, user_id: OWNER },
      {
        anonymous: false,
        owner: true,
        stranger: false,
        "admin account": true,
        "admin header": true,
        "admin header, signed in": true,
      },
    ],
    [
      "unpublished, account gone",
      { is_public: false, user_id: null },
      {
        anonymous: false,
        owner: false,
        stranger: false,
        "admin account": true,
        "admin header": true,
        "admin header, signed in": true,
      },
    ],
  ];

  it("answers every combination of post and viewer", () => {
    for (const [rowName, row, expected] of table) {
      expect(Object.keys(expected).sort()).toEqual(Object.keys(viewers).sort());
      for (const [viewerName, viewer] of Object.entries(viewers)) {
        expect(canSeePlan(viewer, row), `${rowName} for ${viewerName}`).toBe(expected[viewerName]);
      }
    }
  });
});

describe("isUuid", () => {
  it("takes a uuid in either case and nothing else", () => {
    expect(isUuid(OWNER)).toBe(true);
    expect(isUuid("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBe(true);
    for (const value of ["", "not-a-uuid", "plan-1", `${OWNER} `, `${OWNER}x`, OWNER.replace(/-/g, "")]) {
      expect(isUuid(value), value).toBe(false);
    }
  });
});
