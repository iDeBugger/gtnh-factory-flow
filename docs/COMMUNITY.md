# Community plan hub

The community hub lets players share factory plans, browse and preview what
others built, vote, and open any shared plan directly in the editor.

## Architecture

- **Frontend**: `/community` (browser) and the Share button in the editor.
- **API**: the site's routes under `src/server/routes/api/community/**`. All validation,
  stat derivation, vote deduplication, and rate limiting happen here.
- **Storage**: Postgres, reached only by the site's server code
  (`src/lib/server/repos/`) and the live service, each logged in as its own
  role (`gtnh_site`, `gtnh_live`) with only the grants in `db/grants.sql`.
  Postgres is on the stack's internal network and is never exposed to
  browsers; who may see which rows is decided by the server's rules
  (`src/lib/server/services/access.ts`).
- **Blueprints** are not part of the hub: each is its owner's alone, with no
  public shelf, publishing, votes or downloads.
- **Identity**: anonymous. Votes and rate limits key on
  `sha256(salt + client IP + device id)`; raw IPs are never stored.
- **Trust model**: the server re-validates every uploaded plan against
  `factoryProjectSchema` and recomputes all stat-card numbers (power, machine
  count, highest tier, needs/outputs) with the real solver — clients cannot
  fabricate stats.

## Setup

Locally, `npm run dev:local` needs no setup: a database on this machine, the
live service and a file store, all started for you.

A deployed stack runs Postgres beside the site (`docs/deploy.md`):

1. The migrate image applies each new migration in `db/migrations/` once, on
   each deploy, and sets the two login roles and their grants.
2. The site reads `DATABASE_URL` (built by compose from
   `GTNH_SITE_DB_PASSWORD`), and keeps uploaded pictures in `FILE_STORE_DIR`.
3. Make a long random secret for `COMMUNITY_HASH_SALT` (`openssl rand -hex 32`;
   the server warns under 16 characters, and in production refuses to sign in
   without one).
4. The passwords and the secret go in the server's environment
   (`/opt/gtnh/.env`), never in the repo.

Without a database or the secret the rest of the app works normally; the community
endpoints return 503 and the hub page shows an error banner.

## Behavior notes

- Uploads: max 3 MB JSON, name ≤ 80 chars, description ≤ 2000 chars,
  10 uploads per hour per actor. Empty plans are rejected.
- Votes: one per plan per actor; re-sending the same vote retracts it.
  Counters are recomputed from the votes table on every vote, in the
  vote's transaction and under a lock on the voted row, so votes that
  arrive at once all count.
- Views: counted when a plan's preview/detail is opened, not per list render.
- Downloads: counted via the download endpoint (JSON download and
  "Open in editor" both use it). Each count is one statement that adds one
  only on a post the viewer may see, so counts never get lost under races.
- Comments: a comment and its post's comment count are written in one
  transaction, so the count always matches the thread.
- Thumbnails: JPEG data URLs (≤ 400 KB) captured client-side from the canvas
  at share time and stored inline in the row; the capture shrinks itself until
  it fits. Cards without a photo fall back to the plan's top output sprite.
- Accounts: dead-simple username + password (`community_users`). Passwords are
  scrypt-hashed; sessions are HMAC-signed httpOnly cookies (180 days), signed
  with `COMMUNITY_HASH_SALT`. No email, no password reset. Sharing requires an
  account; posts carry `user_id`/`author_name`, and only the signed-in owner
  can update ("Post as → Update …" in the share dialog) or take down a post.
  Votes remain anonymous (IP+device hash).
- Moderation: set `COMMUNITY_ADMIN_TOKEN` and send it as the `x-admin-token`
  header on `DELETE /api/community/plans/<id>` to take down any post, or
  delete rows directly in the database (`docker exec -it gtnh-postgres psql -U postgres`).
