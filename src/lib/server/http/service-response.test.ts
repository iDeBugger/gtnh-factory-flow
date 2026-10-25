import { describe, expect, it } from "vitest";
import { fail, ok, type ServiceErrorKind } from "../services/result";
import { serviceResponse } from "./service-response";

describe("serviceResponse", () => {
  it("answers a value through toBody, with the init's headers", async () => {
    const response = serviceResponse(ok({ id: "p1" }), (value) => ({ plan: value }), {
      headers: { "Cache-Control": "no-store" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ plan: { id: "p1" } });
  });

  it.each<[ServiceErrorKind, number]>([
    ["not-found", 404],
    ["forbidden", 403],
    ["conflict", 409],
    ["bad-request", 400],
    ["unauthorized", 401],
    ["rate-limited", 429],
    ["too-large", 413],
    ["unavailable", 503],
  ])("answers %s with %i and the message as error", async (kind, status) => {
    const response = serviceResponse(fail(kind, "Plan not found."), () => ({}));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Plan not found." });
  });

  it("merges the error's body beside the message", async () => {
    const response = serviceResponse(
      fail("conflict", "This plan is open live.", { body: { live: true } }),
      () => ({}),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This plan is open live.", live: true });
  });

  it("lets the error name its own status", async () => {
    const response = serviceResponse(
      fail("unavailable", "Loading the plan failed.", { status: 500 }),
      () => ({}),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Loading the plan failed." });
  });

  it("keeps a success's cache headers off an error, which answers no-store", async () => {
    const response = serviceResponse(fail("unavailable", "The database is down."), () => ({}), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never lets an error's body replace the message", async () => {
    const response = serviceResponse(
      fail("conflict", "This plan is open live.", { body: { error: "other", live: true } }),
      () => ({}),
    );
    expect(await response.json()).toEqual({ error: "This plan is open live.", live: true });
  });
});
