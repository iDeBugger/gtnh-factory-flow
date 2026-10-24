import { describe, expect, it } from "vitest";
import { withModAndCommunityOn, withModAndCommunityUnset } from "@/test-support/mod-and-community";
import * as list from "./route";
import * as plan from "./[planId]/route";
import * as vote from "./[planId]/vote/route";
import * as comments from "./[planId]/comments/route";
import * as comment from "./[planId]/comments/[commentId]/route";
import * as card from "./[planId]/card/route";
import * as download from "./[planId]/download/route";
import * as preview from "./[planId]/preview/route";
import * as view from "./[planId]/view/route";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const params = { planId: "plan-1", commentId: "comment-1" };

/** Every community plan route and method, called with a request it would otherwise begin to handle. */
const handlers: Array<[string, Handler]> = [
  ["GET /plans", list.GET as unknown as Handler],
  ["POST /plans", list.POST as unknown as Handler],
  ["GET /plans/[id]", plan.GET as unknown as Handler],
  ["PUT /plans/[id]", plan.PUT as unknown as Handler],
  ["DELETE /plans/[id]", plan.DELETE as unknown as Handler],
  ["POST /plans/[id]/vote", vote.POST as unknown as Handler],
  ["GET /plans/[id]/comments", comments.GET as unknown as Handler],
  ["POST /plans/[id]/comments", comments.POST as unknown as Handler],
  ["DELETE /plans/[id]/comments/[id]", comment.DELETE as unknown as Handler],
  ["GET /plans/[id]/card", card.GET as unknown as Handler],
  ["POST /plans/[id]/download", download.POST as unknown as Handler],
  ["POST /plans/[id]/preview", preview.POST as unknown as Handler],
  ["GET /plans/[id]/preview", preview.GET as unknown as Handler],
  ["POST /plans/[id]/view", view.POST as unknown as Handler],
];

function call([name, handler]: [string, Handler]): Promise<Response> {
  const method = name.split(" ")[0]!;
  const request = new Request("http://localhost/api/community/plans/plan-1", {
    method,
    body: method === "GET" ? undefined : "{}",
  });
  return handler(request, { params: Promise.resolve(params) });
}

describe("the community plan routes with the setting unset", () => {
  withModAndCommunityUnset();

  it.each(handlers)("%s answers 404", async (...entry) => {
    const response = await call(entry);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("the community plan routes with the setting on", () => {
  withModAndCommunityOn();

  // This test server has no community database, so each route answers as it
  // always has without one: the hub's 503, the card's redirect to the site
  // image, and no stored preview.
  const unconfigured = { error: "Community hub is not configured." };
  const expected: Record<string, [number, unknown]> = {
    "GET /plans/[id]/card": [302, undefined],
    "GET /plans/[id]/preview": [404, { error: "No preview." }],
  };
  it.each(handlers)("%s answers as before", async (...entry) => {
    const response = await call(entry);
    const body = await response.json().catch(() => undefined);
    const [status, answer] = expected[entry[0]] ?? [503, unconfigured];
    expect(response.status).toBe(status);
    expect(body).toEqual(answer);
  });
});
