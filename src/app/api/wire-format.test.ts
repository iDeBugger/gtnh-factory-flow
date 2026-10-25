import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openLocalDatabase, type LocalDatabase } from "@/lib/server/local-db/database";
import { useInProcessLocalDb } from "@/lib/server/local-db/client";
import { makeSessionToken, saltedKey } from "@/lib/server/community";
import { PROJECT_SCHEMA_VERSION } from "@/lib/model/types";
import { APP_VERSION } from "@/lib/version";
import { withModAndCommunityOn } from "@/test-support/mod-and-community";
import * as library from "./library/route";
import * as design from "./library/designs/[designId]/route";
import * as blueprints from "./blueprints/route";
import * as plans from "./community/plans/route";
import * as plan from "./community/plans/[planId]/route";
import * as comments from "./community/plans/[planId]/comments/route";

/**
 * The exact JSON the API answers, over fixed rows in the local database. The
 * database layer underneath may change; these bytes may not: the client and
 * the game read them. Timestamps are Postgres's `to_json` spelling
 * (`2026-10-25T17:33:50.431+00:00`), bigints are JSON numbers, jsonb arrays
 * stay arrays. A response is compared as its own compact JSON, so key order
 * and number spelling count.
 */

const ANN = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b1";
const PLAN_STEEL = "00000000-0000-4000-8000-00000000c001";
const PLAN_OIL = "00000000-0000-4000-8000-00000000c002";
const PLAN_DRAFT = "00000000-0000-4000-8000-00000000c003";
const COMMENT_ONE = "00000000-0000-4000-8000-00000000d001";
const COMMENT_TWO = "00000000-0000-4000-8000-00000000d002";
const COMMENT_GONE = "00000000-0000-4000-8000-00000000d003";
const BLUEPRINT_SMELTER = "00000000-0000-4000-8000-00000000e001";
const BLUEPRINT_SHARED = "00000000-0000-4000-8000-00000000e002";

const SEED_NAMES: Record<string, string> = {
  [ANN]: "<ann>",
  [BOB]: "<bob>",
  [PLAN_STEEL]: "<plan-steel>",
  [PLAN_OIL]: "<plan-oil>",
  [PLAN_DRAFT]: "<plan-draft>",
  [COMMENT_ONE]: "<comment-one>",
  [COMMENT_TWO]: "<comment-two>",
  [COMMENT_GONE]: "<comment-gone>",
  [BLUEPRINT_SMELTER]: "<blueprint-smelter>",
  [BLUEPRINT_SHARED]: "<blueprint-shared>",
};

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?\+00:00$/;

let local: LocalDatabase;
const cookies: Record<string, string> = {};

const project = (name: string) => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  id: `plan-${name}`,
  name,
  recipes: [],
  nodes: [],
  storages: [],
  edges: [],
  fuelProfiles: [],
});

const needs = JSON.stringify([
  { kind: "item", resourceId: "gregtech:iron_dust", displayName: "Iron Dust", ratePerSecond: 1.5 },
]);
const outputs = JSON.stringify([
  { kind: "fluid", resourceId: "steam", displayName: "Steam", ratePerSecond: 2400 },
]);

async function seed(db: LocalDatabase["db"]): Promise<void> {
  await db.query(
    `insert into community_users (id, username, password_hash, is_admin, created_at, session_epoch) values
      ($1, 'ann', 'x:y', false, '2026-10-01 08:00:00+00', 1761400000123),
      ($2, 'bob', 'x:y', false, '2026-10-02 08:00:00+00', 0)`,
    [ANN, BOB],
  );
  await db.query(
    `insert into library_folders (user_id, id, name, created_at, updated_at, deleted_at) values
      ($1, 'folder-main', 'Main base', '2026-10-10 09:00:00+00', '2026-10-11 09:30:00.5+00', null),
      ($1, 'folder-old', 'Old', '2026-10-10 09:00:00+00', '2026-10-12 10:00:00+00', '2026-10-12 10:00:00+00')`,
    [ANN],
  );
  await db.query(
    `insert into library_designs
      (user_id, id, name, plan, icon, folder_id, closed, favorite, sort_order, community_plan_id,
       created_at, updated_at, plan_updated_at, deleted_at, seq)
     values
      ($1, 'design-steel', 'Steel line', $2, $3, 'folder-main', false, true, 2, $4,
       '2026-10-14 10:00:00+00', '2026-10-25 17:33:50.431+00', '2026-10-25 17:30:00.123456+00', null, 7),
      ($1, 'design-gone', 'Gone', '{}', null, null, true, false, null, null,
       '2026-10-14 10:00:00+00', '2026-10-20 12:00:00+00', '2026-10-20 12:00:00+00', '2026-10-20 12:00:00+00', 0),
      ($5, 'design-bob', 'Bob''s oil', $6, null, null, false, false, 0, null,
       '2026-10-15 10:00:00+00', '2026-10-16 10:00:00+00', '2026-10-16 10:00:00+00', null, 3)`,
    [
      ANN,
      JSON.stringify(project("Steel line")),
      JSON.stringify({ kind: "item", id: "minecraft:iron_ingot" }),
      PLAN_STEEL,
      BOB,
      JSON.stringify(project("Bob's oil")),
    ],
  );
  await db.query(
    `insert into library_design_members (owner_id, design_id, member_id, added_at) values
      ($1, 'design-steel', $2, '2026-10-21 08:00:00+00'),
      ($2, 'design-bob', $1, '2026-10-22 08:00:00+00')`,
    [ANN, BOB],
  );
  await db.query(
    `insert into blueprints
      (id, user_id, name, payload, node_count, storage_count, edge_count, pocket_count, machine_count,
       is_public, description, author_name, published_at, needs, outputs, tags, tags_text, upvotes, downvotes,
       downloads, icon, highest_tier, highest_tier_index, created_at)
     values
      ($1, $3, 'Smelter', '{"nodes":[]}', 3, 1, 2, 0, 3, false, '', 'ann', null, '[]', '[]', '[]', '', 0, 0,
       0, null, null, -1, '2026-10-18 08:00:00+00'),
      ($2, $3, 'Shared bus', '{"nodes":[]}', 5, 2, 4, 1, 5, true, 'A bus.', 'ann', '2026-10-19 09:00:00+00',
       $4, $5, '["bus","lv"]', 'bus lv', 4, 1, 12, $6, 'LV', 1, '2026-10-19 08:00:00+00')`,
    [
      BLUEPRINT_SMELTER,
      BLUEPRINT_SHARED,
      ANN,
      needs,
      outputs,
      JSON.stringify({ kind: "item", id: "gregtech:wire" }),
    ],
  );
  await db.query(
    `insert into community_plans
      (id, name, description, game_version, dataset_version, plan, needs, outputs, total_eu_t, machine_count,
       node_count, storage_count, edge_count, highest_tier, highest_tier_index, upvotes, downvotes, downloads,
       views, uploader_key, user_id, author_name, created_at, updated_at, tags, tags_text, is_public, icon,
       stats_version, comment_count, last_comment_at, last_activity_at)
     values
      ($1, 'Steel line', 'Bronze to steel.', '2.9.0', 'gtnh-2.9.0', $4, $6, $7, 120.5, 4, 6, 1, 5, 'MV', 2, 3, 1, 9,
       40, 'k', $8, 'ann', '2026-10-20 10:00:00+00', '2026-10-21 11:00:00.25+00', '["steel","mv"]', 'steel mv',
       true, $9, $10, 2, '2026-10-23 12:00:00+00', '2026-10-23 12:00:00+00'),
      ($2, 'Oil cracking', '', '2.8.1', 'gtnh-2.8.1', $5, '[]', '[]', 0, 0, 0, 0, 0, null, -1, 0, 0, 0, 0, 'k', $11,
       'bob', '2026-10-22 10:00:00+00', '2026-10-22 10:00:00+00', '[]', '', true, null, $10, 0, null,
       '2026-10-22 10:00:00+00'),
      ($3, 'Draft', '', '2.9.0', 'gtnh-2.9.0', $5, '[]', '[]', 0, 0, 0, 0, 0, null, -1, 0, 0, 0, 0, 'k', $11,
       'bob', '2026-10-24 10:00:00+00', '2026-10-24 10:00:00+00', '[]', '', false, null, $10, 0, null,
       '2026-10-24 10:00:00+00')`,
    [
      PLAN_STEEL,
      PLAN_OIL,
      PLAN_DRAFT,
      JSON.stringify(project("Steel line")),
      JSON.stringify(project("Other")),
      needs,
      outputs,
      ANN,
      JSON.stringify({ kind: "fluid", id: "steam" }),
      APP_VERSION,
      BOB,
    ],
  );
  await db.query(
    `insert into community_comments (id, plan_id, user_id, author_name, body, created_at, deleted_at) values
      ($1, $4, $5, 'bob', 'Nice line.', '2026-10-22 12:00:00+00', null),
      ($2, $4, $6, 'ann', 'Thanks!', '2026-10-23 12:00:00+00', null),
      ($3, $4, $5, 'bob', 'Gone.', '2026-10-23 13:00:00+00', '2026-10-23 13:05:00+00')`,
    [COMMENT_ONE, COMMENT_TWO, COMMENT_GONE, PLAN_STEEL, BOB, ANN],
  );
  // ann's own vote on bob's post, keyed as the vote route keys a signed-in voter.
  await db.query(
    `insert into community_votes (plan_id, voter_key, value, created_at) values ($1, $2, 1, '2026-10-22 13:00:00+00')`,
    [PLAN_OIL, saltedKey(`user:${ANN}`)],
  );
}

beforeAll(async () => {
  vi.stubEnv("LOCAL_DB", "1");
  vi.stubEnv("COMMUNITY_HASH_SALT", "wire-format-test-salt");
  local = await openLocalDatabase();
  useInProcessLocalDb(local.handle);
  await seed(local.db);
  cookies.ann = `gtnh_session=${makeSessionToken(ANN, 1761400000123)}`;
  cookies.bob = `gtnh_session=${makeSessionToken(BOB, 0)}`;
}, 60_000);

afterAll(async () => {
  useInProcessLocalDb(undefined);
  await local?.close();
  vi.unstubAllEnvs();
});

function get(path: string, who?: "ann" | "bob"): Request {
  return new Request(`http://localhost${path}`, { headers: who ? { cookie: cookies[who]! } : {} });
}

const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });

/**
 * The response's status and body, the body checked to be the compact JSON of
 * itself (so the pretty form below holds every byte), with the seeded ids
 * named.
 */
async function wire(response: Response): Promise<{ status: number; body: unknown; text: string }> {
  const text = await response.text();
  const body = JSON.parse(text) as unknown;
  expect(JSON.stringify(body)).toBe(text);
  let named = JSON.stringify(body, null, 2);
  for (const [id, name] of Object.entries(SEED_NAMES)) {
    named = named.replaceAll(id, name);
  }
  return { status: response.status, body, text: named };
}

describe("the API's JSON", () => {
  it("GET /api/library", async () => {
    const answer = await wire(await library.GET(get("/api/library", "ann")));
    expect(answer.status).toBe(200);
    const body = answer.body as { designs: Array<{ updatedAt: string }> };
    expect(body.designs[0]!.updatedAt).toMatch(TIMESTAMP);
    expect(answer.text).toMatchInlineSnapshot(`
      "{
        "designs": [
          {
            "id": "design-steel",
            "name": "Steel line",
            "icon": null,
            "folderId": "folder-main",
            "closed": false,
            "favorite": true,
            "order": 2,
            "communityPlanId": "<plan-steel>",
            "createdAt": "2026-10-14T10:00:00+00:00",
            "updatedAt": "2026-10-25T17:33:50.431+00:00",
            "planUpdatedAt": "2026-10-25T17:30:00.123456+00:00",
            "deletedAt": null,
            "members": [
              {
                "id": "<bob>",
                "username": "bob"
              }
            ]
          },
          {
            "id": "design-gone",
            "name": "Gone",
            "icon": null,
            "folderId": null,
            "closed": true,
            "favorite": false,
            "order": null,
            "communityPlanId": null,
            "createdAt": "2026-10-14T10:00:00+00:00",
            "updatedAt": "2026-10-20T12:00:00+00:00",
            "planUpdatedAt": "2026-10-20T12:00:00+00:00",
            "deletedAt": "2026-10-20T12:00:00+00:00",
            "members": []
          }
        ],
        "folders": [
          {
            "id": "folder-main",
            "name": "Main base",
            "createdAt": "2026-10-10T09:00:00+00:00",
            "updatedAt": "2026-10-11T09:30:00.5+00:00",
            "deletedAt": null
          },
          {
            "id": "folder-old",
            "name": "Old",
            "createdAt": "2026-10-10T09:00:00+00:00",
            "updatedAt": "2026-10-12T10:00:00+00:00",
            "deletedAt": "2026-10-12T10:00:00+00:00"
          }
        ],
        "shared": [
          {
            "ownerId": "<bob>",
            "ownerName": "bob",
            "id": "design-bob",
            "name": "Bob's oil",
            "icon": null,
            "updatedAt": "2026-10-16T10:00:00+00:00",
            "planUpdatedAt": "2026-10-16T10:00:00+00:00",
            "members": [
              {
                "id": "<ann>",
                "username": "ann"
              }
            ]
          }
        ]
      }"
    `);
  });

  it("GET /api/library for a member", async () => {
    const answer = await wire(await library.GET(get("/api/library", "bob")));
    expect(answer.status).toBe(200);
    expect(answer.text).toMatchInlineSnapshot(`
      "{
        "designs": [
          {
            "id": "design-bob",
            "name": "Bob's oil",
            "icon": null,
            "folderId": null,
            "closed": false,
            "favorite": false,
            "order": 0,
            "communityPlanId": null,
            "createdAt": "2026-10-15T10:00:00+00:00",
            "updatedAt": "2026-10-16T10:00:00+00:00",
            "planUpdatedAt": "2026-10-16T10:00:00+00:00",
            "deletedAt": null,
            "members": [
              {
                "id": "<ann>",
                "username": "ann"
              }
            ]
          }
        ],
        "folders": [],
        "shared": [
          {
            "ownerId": "<ann>",
            "ownerName": "ann",
            "id": "design-steel",
            "name": "Steel line",
            "icon": null,
            "updatedAt": "2026-10-25T17:33:50.431+00:00",
            "planUpdatedAt": "2026-10-25T17:30:00.123456+00:00",
            "members": [
              {
                "id": "<bob>",
                "username": "bob"
              }
            ]
          }
        ]
      }"
    `);
  });

  it("GET /api/library/designs/<id>", async () => {
    const answer = await wire(
      await design.GET(
        get("/api/library/designs/design-steel", "ann"),
        params({ designId: "design-steel" }),
      ),
    );
    expect(answer.status).toBe(200);
    const body = answer.body as { seq: unknown; design: { updatedAt: string } };
    expect(typeof body.seq).toBe("number");
    expect(body.design.updatedAt).toMatch(TIMESTAMP);
    expect(answer.text).toMatchInlineSnapshot(`
      "{
        "design": {
          "id": "design-steel",
          "name": "Steel line",
          "icon": null,
          "folderId": "folder-main",
          "closed": false,
          "favorite": true,
          "order": 2,
          "communityPlanId": "<plan-steel>",
          "createdAt": "2026-10-14T10:00:00+00:00",
          "updatedAt": "2026-10-25T17:33:50.431+00:00",
          "planUpdatedAt": "2026-10-25T17:30:00.123456+00:00",
          "deletedAt": null
        },
        "plan": {
          "id": "plan-Steel line",
          "name": "Steel line",
          "edges": [],
          "nodes": [],
          "recipes": [],
          "storages": [],
          "fuelProfiles": [],
          "schemaVersion": 1
        },
        "ownerId": "<ann>",
        "role": "owner",
        "seq": 7,
        "live": false
      }"
    `);
  });

  it("GET /api/blueprints", async () => {
    const answer = await wire(await blueprints.GET(get("/api/blueprints", "ann")));
    expect(answer.status).toBe(200);
    const body = answer.body as { blueprints: Array<{ needs: unknown }> };
    expect(body.blueprints.every((row) => Array.isArray(row.needs))).toBe(true);
    expect(answer.text).toMatchInlineSnapshot(`
      "{
        "blueprints": [
          {
            "id": "<blueprint-shared>",
            "name": "Shared bus",
            "createdAt": "2026-10-19T08:00:00+00:00",
            "nodeCount": 5,
            "storageCount": 2,
            "edgeCount": 4,
            "pocketCount": 1,
            "machineCount": 5,
            "isPublic": true,
            "description": "A bus.",
            "authorName": "ann",
            "publishedAt": "2026-10-19T09:00:00+00:00",
            "upvotes": 4,
            "downvotes": 1,
            "score": 3,
            "downloads": 12,
            "isMine": true,
            "needs": [
              {
                "kind": "item",
                "resourceId": "gregtech:iron_dust",
                "displayName": "Iron Dust",
                "ratePerSecond": 1.5
              }
            ],
            "outputs": [
              {
                "kind": "fluid",
                "resourceId": "steam",
                "displayName": "Steam",
                "ratePerSecond": 2400
              }
            ],
            "tags": [
              "bus",
              "lv"
            ],
            "icon": {
              "id": "gregtech:wire",
              "kind": "item"
            },
            "highestTier": "LV",
            "highestTierIndex": 1
          },
          {
            "id": "<blueprint-smelter>",
            "name": "Smelter",
            "createdAt": "2026-10-18T08:00:00+00:00",
            "nodeCount": 3,
            "storageCount": 1,
            "edgeCount": 2,
            "pocketCount": 0,
            "machineCount": 3,
            "isPublic": false,
            "description": "",
            "authorName": "ann",
            "upvotes": 0,
            "downvotes": 0,
            "score": 0,
            "downloads": 0,
            "isMine": true,
            "needs": [],
            "outputs": [],
            "tags": [],
            "highestTierIndex": -1
          }
        ]
      }"
    `);
  });

  describe("with the community on", () => {
    withModAndCommunityOn();

    it("GET /api/community/plans", async () => {
      const answer = await wire(
        await plans.GET(get("/api/community/plans?sort=new&deviceId=device-1", "ann")),
      );
      expect(answer.status).toBe(200);
      const body = answer.body as { plans: Array<{ updatedAt: string; needs: unknown }> };
      expect(body.plans[0]!.updatedAt).toMatch(TIMESTAMP);
      expect(body.plans.every((row) => Array.isArray(row.needs))).toBe(true);
      expect(answer.text).toMatchInlineSnapshot(`
        "{
          "plans": [
            {
              "authorName": "bob",
              "isMine": false,
              "id": "<plan-oil>",
              "name": "Oil cracking",
              "description": "",
              "gameVersion": "2.8.1",
              "datasetVersionId": "gtnh-2.8.1",
              "tags": [],
              "isPublic": true,
              "needs": [],
              "outputs": [],
              "totalEuT": 0,
              "machineCount": 0,
              "nodeCount": 0,
              "storageCount": 0,
              "edgeCount": 0,
              "highestTierIndex": -1,
              "upvotes": 0,
              "downvotes": 0,
              "score": 0,
              "downloads": 0,
              "views": 0,
              "createdAt": "2026-10-22T10:00:00+00:00",
              "updatedAt": "2026-10-22T10:00:00+00:00",
              "commentCount": 0,
              "lastActivityAt": "2026-10-22T10:00:00+00:00",
              "myVote": 1
            },
            {
              "authorName": "ann",
              "isMine": true,
              "id": "<plan-steel>",
              "name": "Steel line",
              "description": "Bronze to steel.",
              "gameVersion": "2.9.0",
              "datasetVersionId": "gtnh-2.9.0",
              "tags": [
                "steel",
                "mv"
              ],
              "isPublic": true,
              "icon": {
                "id": "steam",
                "kind": "fluid"
              },
              "needs": [
                {
                  "kind": "item",
                  "resourceId": "gregtech:iron_dust",
                  "displayName": "Iron Dust",
                  "ratePerSecond": 1.5
                }
              ],
              "outputs": [
                {
                  "kind": "fluid",
                  "resourceId": "steam",
                  "displayName": "Steam",
                  "ratePerSecond": 2400
                }
              ],
              "totalEuT": 120.5,
              "machineCount": 4,
              "nodeCount": 6,
              "storageCount": 1,
              "edgeCount": 5,
              "highestTier": "MV",
              "highestTierIndex": 2,
              "upvotes": 3,
              "downvotes": 1,
              "score": 2,
              "downloads": 9,
              "views": 40,
              "createdAt": "2026-10-20T10:00:00+00:00",
              "updatedAt": "2026-10-21T11:00:00.25+00:00",
              "commentCount": 2,
              "lastCommentAt": "2026-10-23T12:00:00+00:00",
              "lastActivityAt": "2026-10-23T12:00:00+00:00"
            }
          ],
          "total": 2,
          "page": 1,
          "pageSize": 24,
          "gameVersions": [
            "2.9.0",
            "2.8.1"
          ]
        }"
      `);
    });

    it("GET /api/community/plans/<id>", async () => {
      const answer = await wire(
        await plan.GET(
          get(`/api/community/plans/${PLAN_STEEL}?deviceId=device-1`, "ann"),
          params({ planId: PLAN_STEEL }),
        ),
      );
      expect(answer.status).toBe(200);
      const body = answer.body as { plan: { updatedAt: string; needs: unknown } };
      expect(body.plan.updatedAt).toMatch(TIMESTAMP);
      expect(Array.isArray(body.plan.needs)).toBe(true);
      expect(answer.text).toMatchInlineSnapshot(`
        "{
          "plan": {
            "authorName": "ann",
            "isMine": true,
            "id": "<plan-steel>",
            "name": "Steel line",
            "description": "Bronze to steel.",
            "gameVersion": "2.9.0",
            "datasetVersionId": "gtnh-2.9.0",
            "tags": [
              "steel",
              "mv"
            ],
            "isPublic": true,
            "icon": {
              "id": "steam",
              "kind": "fluid"
            },
            "needs": [
              {
                "kind": "item",
                "resourceId": "gregtech:iron_dust",
                "displayName": "Iron Dust",
                "ratePerSecond": 1.5
              }
            ],
            "outputs": [
              {
                "kind": "fluid",
                "resourceId": "steam",
                "displayName": "Steam",
                "ratePerSecond": 2400
              }
            ],
            "totalEuT": 120.5,
            "machineCount": 4,
            "nodeCount": 6,
            "storageCount": 1,
            "edgeCount": 5,
            "highestTier": "MV",
            "highestTierIndex": 2,
            "upvotes": 3,
            "downvotes": 1,
            "score": 2,
            "downloads": 9,
            "views": 40,
            "createdAt": "2026-10-20T10:00:00+00:00",
            "updatedAt": "2026-10-21T11:00:00.25+00:00",
            "commentCount": 2,
            "lastCommentAt": "2026-10-23T12:00:00+00:00",
            "lastActivityAt": "2026-10-23T12:00:00+00:00"
          }
        }"
      `);
    });

    it("GET /api/community/plans/<id>/comments", async () => {
      const answer = await wire(
        await comments.GET(
          get(`/api/community/plans/${PLAN_STEEL}/comments`, "bob"),
          params({ planId: PLAN_STEEL }),
        ),
      );
      expect(answer.status).toBe(200);
      expect(answer.text).toMatchInlineSnapshot(`
        "{
          "comments": [
            {
              "id": "<comment-one>",
              "planId": "<plan-steel>",
              "authorName": "bob",
              "body": "Nice line.",
              "createdAt": "2026-10-22T12:00:00+00:00",
              "isMine": true,
              "canDelete": true
            },
            {
              "id": "<comment-two>",
              "planId": "<plan-steel>",
              "authorName": "ann",
              "body": "Thanks!",
              "createdAt": "2026-10-23T12:00:00+00:00",
              "isMine": false,
              "canDelete": false
            }
          ]
        }"
      `);
    });
  });
});
