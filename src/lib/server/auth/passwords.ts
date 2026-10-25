import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Dead-simple accounts: username + password, scrypt-hashed, with an HMAC-signed
// session cookie (session.ts, shared with the live service). No email, no
// reset flow: this is a hobby community site. Every token carries the
// account's session_epoch; "Sign out everywhere" moves it (bumpSessionEpoch).
// A password change, when one exists, does the same `session_epoch =
// Date.now()` in its UPDATE and mints a fresh token for the changer.
// ---------------------------------------------------------------------------

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
  options: { maxmem: number },
) => Promise<Buffer>;

/**
 * The key derivation runs on libuv's threadpool, never on the event loop:
 * one derivation takes about 40 ms of CPU, and the synchronous form held
 * every page, API and dataset answer of the whole site for that long on each
 * sign-in attempt, which an unauthenticated flood turns into an outage. Node's
 * defaults (N=16384, r=8, p=1) need 16 MB; the ceiling leaves room above them.
 */
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

/**
 * Derivations in flight at once, and how many may wait behind them. The
 * threadpool has four threads and the dataset's shard reads queue on the same
 * pool, so a sign-in flood may never hold every thread; two at a time keeps
 * the dataset API's latency its own. Past the queue a check is refused and
 * the route answers "slow down" rather than holding the request open.
 */
export const KDF_CONCURRENCY = 2;
export const KDF_QUEUE_MAX = 32;
let kdfRunning = 0;
const kdfWaiting: Array<() => void> = [];

/** Thrown when more password checks arrive than the queue holds. */
export class PasswordCheckBusyError extends Error {
  constructor() {
    super("Too many sign-in attempts at once.");
    this.name = "PasswordCheckBusyError";
  }
}

/** For tests: derivations running right now. */
export function passwordChecksInFlight(): number {
  return kdfRunning;
}

async function deriveKey(password: string, salt: string): Promise<Buffer> {
  if (kdfRunning >= KDF_CONCURRENCY) {
    if (kdfWaiting.length >= KDF_QUEUE_MAX) {
      throw new PasswordCheckBusyError();
    }
    await new Promise<void>((resolve) => kdfWaiting.push(resolve));
  }
  kdfRunning += 1;
  try {
    return await scrypt(password, salt, SCRYPT_KEY_BYTES, { maxmem: SCRYPT_MAX_MEMORY });
  } finally {
    kdfRunning -= 1;
    kdfWaiting.shift()?.();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await deriveKey(password, salt)).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * A stored hash of nothing anyone types: a sign-in attempt for a name nobody
 * has derives against it, so an unknown name costs the same as a wrong
 * password and the answer's timing says nothing about which names exist.
 */
const DUMMY_PASSWORD_HASH =
  "5c669673f6136c24b28f9eda8acbe809:8fcadba8148d088a43a6cc903f5e95bc0db74e714a1393c295e4221fc27995cf820156d205a3e42a79ee585f886a623a90213fb9ba618392db69ffe37783c3ad";

/**
 * Whether the password matches the stored `salt:hash`. With no stored hash
 * (no such account) the derivation still runs, against the dummy, and the
 * answer is false whatever it finds.
 */
export async function checkPassword(password: string, stored: string | undefined): Promise<boolean> {
  const [salt, hash] = (stored ?? DUMMY_PASSWORD_HASH).split(":");
  if (!salt || !hash) {
    return false;
  }
  const candidate = await deriveKey(password, salt);
  const expected = Buffer.from(hash, "hex");
  const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
  return stored !== undefined && matches;
}
