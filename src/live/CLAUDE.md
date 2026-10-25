# Live service (src/live)

The WebSocket server for live plans: a separate Node process beside Next.js (`next start` cannot hold sockets).
Architecture, protocol notes and REST: `docs/live.md`. Production: `docs/deploy.md`. The contract with
the game is `docs/design/cloud-live.md` in the game's repository: frames and ops must stay as it says, and a change to
`src/lib/live/ops.ts` or `live-vectors.json` changes the game's engine too.

- One process, one live service per database. Rooms (`room.ts`) per doc key `<ownerId>:<designId>`; everything that
  changes a room runs through its queue, so batches apply in arrival order and a snapshot never sees half a batch.
- Never a database write per edit: a room writes when it opens (the lease, with the plan read back), every 30 s (the
  lease, and the members read again), and when it flushes (at most every 8 s while edited, and when it closes, a
  minute after the last person left). Every whole-plan write goes through the service's `FlushQueue` (a few at a
  time, resting after failures). The instance is small.
- A batch applies to the room's plan in memory at once and is journalled (`journal.ts` groups a turn's lines into one
  write and one sync); it is broadcast only once its line is on disk. Snapshots, flushes and resend acks wait for the
  journal (`Room.whenDurable`). A journal that cannot be written fails the room (`peer.reload`: sockets close 1012).
  A flush trims the journal. Start-up replays every journal. Never send anything that is not on disk yet.
- A batch costs what it touches, never the plan's size: the room's plan is `LiveDoc` (`doc.ts`, an id index per
  collection kept for the room's life, checked against `applyOps` in `doc.test.ts`), batches are staged and checked
  there (`batch.ts`). Nothing per op may scan a collection. `doc.test.ts` holds the biggest batch on a 40,000-card
  plan under 50 ms.
- Leases carry a token (`live_lease_token`): every renewal, flush and release is conditional on it. A room that finds
  it changed writes nothing more and fails as above.
- A room's last 1,000 batch ids go to disk beside its journal at every flush, before the trim, and come back when it
  opens: a batch resent after a restart is acknowledged, never applied twice.
- Every thing a batch puts or patches must pass its collection's schema afterwards (`src/lib/live/validate.ts`), plan
  fields their field's rule. A batch is refused whole, with its `cid` in the error. What is stored is the schema's
  output: ops making it so are appended to the batch. Names reaching a prototype and values nested past 64 levels are
  refused as the batch is read (`readOps`).
- The server writes comment stamps and a task's `createdBy`; the client's values are replaced.
- Flushes, renewals and lease takes only touch designs that are not tombstoned: a deleted plan is never written back.
- Sessions: `src/lib/server/auth/session.ts`, the website's own check (constant time); a token whose epoch is not the
  account's (signed out everywhere) is refused as no sign-in (4001). Origins: `LIVE_ALLOWED_ORIGINS`; a
  client sending no Origin (the game) is let in only while `NEXT_PUBLIC_MOD_AND_COMMUNITY` is `on`
  (`isModAndCommunityOn`, read at runtime here); off, that upgrade, a `client:"game"` hello and `/live/nearby` are
  refused. Tests of the game paths turn it on with `withModAndCommunityOn()` (`src/test-support/`). Limits that
  need no database come before any lookup (upgrades per address and account, sockets per account); accounts are
  cached a minute. The client address is read by the site's shared rule (`src/lib/server/http/client-address.ts`:
  `X-Client-Ip`, else `CF-Connecting-IP`, IP literals only, IPv6 on its /64) only on requests from loopback
  or from a peer `LIVE_TRUSTED_PROXIES` names (`trusted-proxies.ts`; in Docker it is the `edge` network's gateway,
  the address docker-proxy dials from); any other peer is its own address, and one sending `X-Client-Ip` is warned
  about once. Keep the list to the proxy's address: a wide subnet lets every container on it name any address.
  Exam: `service.test.ts` "where a request came from", `trusted-proxies.test.ts`.
- Every cost an account can cause has a limit charged before the cost: frames by size before decoding (the intake
  budget), plan opens per minute before the membership query, plan bytes held across open rooms
  (`LIVE_MAX_PLAN_BYTES`; memory is about four times it) before a room opens and again once it holds its plan
  (the stored size is a read before the lease), and the rooms an account left to
  linger (its oldest closes past its share). A new path that reads, decodes or opens anything joins this list.
- `/internal/*` (Bearer `LIVE_INTERNAL_TOKEN`) is for the Next.js routes; Caddy routes only `/live` and `/live/*` here.
- Production runs the bundle `npm run build:live` makes (`dist-live/live.mjs`, gitignored); development runs the
  sources with tsx (`npm run live`, `npm run dev:local`).
- Exam: `service.test.ts` (in-process, real sockets, the local database). Run it after any change here.
