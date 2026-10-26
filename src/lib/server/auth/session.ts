import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The account session token: `<userId>.<expiresMs>.<epoch>.<hmac>`,
 * HMAC-SHA256 over `<userId>.<expiresMs>.<epoch>` with COMMUNITY_HASH_SALT.
 * The epoch is the account's `session_epoch` at sign-in: "Sign out
 * everywhere" moves the row's epoch, and a token whose epoch differs is
 * refused by whoever loads the account, so every token of the account stops
 * at once with no session table. Tokens minted before the epoch existed have
 * three parts and read as epoch 0, the column's default, until they expire or
 * the account signs out everywhere. The website keeps the token in the
 * `gtnh_session` cookie; the game sends the same cookie, the live socket's
 * upgrade included. Shared by the Next.js routes (sessions.ts) and the live
 * service, so both accept exactly the same tokens. No database here.
 */

export const SESSION_COOKIE = "gtnh_session";
export const SESSION_DAYS = 180;

const SESSION_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_NUMBER = /^\d{1,16}$/;
const SESSION_SIGNATURE = /^[0-9a-f]{64}$/;

/** Development only: a checkout signs in with no setup. Never a production key. */
const DEVELOPMENT_SECRET = "gtnh-factory-hub";

/**
 * The secret behind sessions and the hashed keys: COMMUNITY_HASH_SALT. In
 * production a missing, blank or development value refuses, so a server
 * without it has no sign-in rather than forgeable sign-in (the value is in
 * this public repository). The value is used untrimmed: trimming would
 * change an existing key and sign everyone out.
 */
export function sessionSecret(): string {
  const value = process.env.COMMUNITY_HASH_SALT;
  if (value !== undefined && value.trim() !== "" && value !== DEVELOPMENT_SECRET) {
    return value;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Sign-in is not set up on this server.");
  }
  return DEVELOPMENT_SECRET;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

export interface SessionClaims {
  userId: string;
  expires: number;
  /** The account's session epoch when the token was made; 0 for a token from before epochs. */
  epoch: number;
}

export function makeSessionToken(userId: string, epoch = 0, now = Date.now()): string {
  const expires = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${userId}.${expires}.${epoch}`;
  return `${payload}.${sign(payload)}`;
}

/** The session token in a Cookie header, if there is one. */
export function readSessionCookie(cookieHeader: string | null | undefined): string | undefined {
  const match = (cookieHeader ?? "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match?.[1];
}

/**
 * The account a token names, when its signature holds (compared in constant
 * time) and it has not expired; otherwise undefined. Says nothing about
 * whether the account still exists or its epoch still matches: the caller
 * that loads the account checks the epoch.
 */
export function verifySessionToken(token: string, now = Date.now()): SessionClaims | undefined {
  const parts = token.split(".");
  // Three parts is the form before epochs; the two forms differ in part count, so neither can be
  // rewritten into the other.
  if (parts.length !== 3 && parts.length !== 4) {
    return undefined;
  }
  const signature = parts[parts.length - 1]!;
  const [userId, expiresText] = parts as [string, string, ...string[]];
  const epochText = parts.length === 4 ? parts[2]! : undefined;
  if (
    !SESSION_USER_ID.test(userId) ||
    !SESSION_NUMBER.test(expiresText) ||
    (epochText !== undefined && !SESSION_NUMBER.test(epochText)) ||
    !SESSION_SIGNATURE.test(signature)
  ) {
    return undefined;
  }
  const payload = epochText === undefined ? `${userId}.${expiresText}` : `${userId}.${expiresText}.${epochText}`;
  const expected = Buffer.from(sign(payload), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }
  const expires = Number(expiresText);
  if (expires < now) {
    return undefined;
  }
  return { userId, expires, epoch: epochText === undefined ? 0 : Number(epochText) };
}
