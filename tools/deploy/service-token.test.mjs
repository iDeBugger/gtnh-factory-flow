import { describe, expect, it } from "vitest";
import { signServiceToken, verifyServiceToken } from "./service-token.mjs";

const SECRET = "a".repeat(64);

describe("the service token", () => {
  it("signs a token PostgREST accepts for the service role", () => {
    const token = signServiceToken(SECRET);
    const [header, payload] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      role: "service_role",
      iss: "gtnh",
    });
    expect(verifyServiceToken(token, SECRET)).toBe(true);
    expect(verifyServiceToken(token, "b".repeat(64))).toBe(false);
    const tampered = Buffer.from(JSON.stringify({ role: "anon", iss: "gtnh" })).toString(
      "base64url",
    );
    const [h, , s] = token.split(".");
    expect(verifyServiceToken(`${h}.${tampered}.${s}`, SECRET)).toBe(false);
    expect(verifyServiceToken("not.a.token", SECRET)).toBe(false);
    expect(verifyServiceToken(token, "")).toBe(false);
  });
});
