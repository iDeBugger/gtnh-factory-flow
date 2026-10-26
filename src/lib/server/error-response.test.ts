import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMUNITY_DB_DOWN_MESSAGE } from "./community-db-down";
import { DatasetNotFoundError } from "./dataset-query";
import { datasetErrorResponse, serverErrorResponse } from "./error-response";

describe("a route's answer for an unexpected error", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the fallback sentence, and the database's own text goes to the log only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = serverErrorResponse(
      new Error('relation "community_users" does not exist at /srv/app/x'),
      "Sign in failed.",
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Sign in failed." });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("passes on the database-down line wherever an error wraps it, with the route's status", async () => {
    const response = serverErrorResponse(
      new Error(`Membership check failed: ${COMMUNITY_DB_DOWN_MESSAGE}`),
      "The plan could not be shared.",
      { status: 503 },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: COMMUNITY_DB_DOWN_MESSAGE });
  });

  it("answers an unserved dataset with 404 and keeps the route's headers", async () => {
    const response = datasetErrorResponse(new DatasetNotFoundError(), "Dataset prewarm failed.", {
      "Cache-Control": "no-store",
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Dataset not found." });
  });
});
