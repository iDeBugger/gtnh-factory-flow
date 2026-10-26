# Community plan hub

The community hub lets players share factory plans, browse and preview what
others built, vote, and open any shared plan directly in the editor.

## Architecture

- **Frontend**: `/community` (browser) and the Share button in the editor.
- **API**: Next.js routes under `src/app/api/community/**`. All validation,
  stat derivation, vote deduplication, and rate limiting happen here.
- **Storage**: Postgres behind PostgREST, accessed exclusively with the
  service-role token from the API routes. Row level security is enabled with
  no public policies and there is no anon role, so a request without the
  token reads nothing.
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

A deployed stack runs Postgres and PostgREST beside the site (`docs/deploy.md`):

1. `supabase/schema.sql` and every migration are applied on each deploy by the
   migrate image.
2. The site reads `POSTGREST_URL` and `POSTGREST_SERVICE_TOKEN` (a JWT for the
   `service_role`, made with `tools/deploy/service-token.mjs`), and keeps
   uploaded pictures in `FILE_STORE_DIR`.
3. Make a long random secret for `COMMUNITY_HASH_SALT` (`openssl rand -hex 32`;
   the server warns under 16 characters, and in production refuses to sign in
   without one).
4. All of them go in the server's environment (`/opt/gtnh/.env`), never in the
   repo.

Without these variables the rest of the app works normally; the community
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
