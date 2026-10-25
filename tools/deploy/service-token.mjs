#!/usr/bin/env node
// The service token the site and the live service send PostgREST: an HS256 JWT
// for the `service_role`, signed with PostgREST's JWT secret. It has no expiry:
// rotating it means a new POSTGREST_JWT_SECRET and a new token.
//
//   printf %s "$POSTGREST_JWT_SECRET" | node tools/deploy/service-token.mjs
//
// The secret is read from stdin so it never appears in a process list or a
// shell history.
import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const HEADER = { alg: "HS256", typ: "JWT" };
const PAYLOAD = { role: "service_role", iss: "gtnh" };

const base64url = (data) => Buffer.from(data).toString("base64url");

function sign(input, secret) {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

/** A token PostgREST accepts as the service role. */
export function signServiceToken(secret) {
  if (!secret) {
    throw new Error("No JWT secret.");
  }
  const input = `${base64url(JSON.stringify(HEADER))}.${base64url(JSON.stringify(PAYLOAD))}`;
  return `${input}.${sign(input, secret)}`;
}

/** True when `token` is an HS256 JWT signed with `secret` that names the service role. */
export function verifyServiceToken(token, secret) {
  if (typeof token !== "string" || !secret) {
    return false;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }
  const [header, payload, signature] = parts;
  const expected = Buffer.from(sign(`${header}.${payload}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return false;
  }
  try {
    const head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return head.alg === "HS256" && claims.role === "service_role";
  } catch {
    return false;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  if (!secret) {
    console.error("Pipe PostgREST's JWT secret on stdin.");
    process.exit(1);
  }
  console.log(signServiceToken(secret));
}
