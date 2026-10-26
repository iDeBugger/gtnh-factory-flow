-- The app's schema for a fresh database. The migration runner
-- (tools/db/migrate.ts) applies each file in db/migrations once, in name
-- order, and records it in schema_migrations; a later change is a new file,
-- never an edit to an applied one.
--
-- Access model: only the server talks to these tables, so all validation and
-- rate limiting happens in the app. Who may see and change which rows is the
-- services' rules (src/lib/server/services/access.ts); what each process may
-- touch at all is its role's grants (db/grants.sql). Row security stays off:
-- with no policies it would hide every row from the app roles.

-- ---------------------------------------------------------------------------
-- ACCOUNTS.
create table community_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (char_length(username) between 3 and 24),
  password_hash text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  -- Sign out everywhere: every session token carries the account's epoch at
  -- sign-in and is refused once the row's epoch moved. "Sign out everywhere"
  -- sets it to the current time in milliseconds, so every token of the
  -- account, on every device, stops verifying at once without a session table.
  session_epoch bigint not null default 0
);

-- ---------------------------------------------------------------------------
-- COMMUNITY POSTS.
create table community_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  game_version text not null default '',
  dataset_version text not null default '',
  plan jsonb not null,
  thumbnail_data_url text,
  needs jsonb not null default '[]'::jsonb,
  outputs jsonb not null default '[]'::jsonb,
  total_eu_t double precision not null default 0,
  machine_count integer not null default 0,
  node_count integer not null default 0,
  storage_count integer not null default 0,
  edge_count integer not null default 0,
  highest_tier text,
  highest_tier_index integer not null default -1,
  upvotes integer not null default 0,
  downvotes integer not null default 0,
  score integer generated always as (upvotes - downvotes) stored,
  downloads integer not null default 0,
  views integer not null default 0,
  uploader_key text not null,
  user_id uuid references community_users (id) on delete cascade,
  author_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Author-curated tags, normalized lowercase; tags_text is the space-joined
  -- copy the app maintains so ilike search reaches into tags.
  tags jsonb not null default '[]'::jsonb,
  tags_text text not null default '',
  -- Unpublish without deleting: a private post stays on the owner's Mine
  -- shelf, keeping its votes and downloads.
  is_public boolean not null default true,
  -- The item face the author picked for list rows: {kind, resourceId, icon refs}.
  icon jsonb,
  -- The app release whose solver computed the stored stat card. The plan
  -- detail read recomputes stats from the plan JSON when this trails the
  -- running release. Empty means unknown, which counts as stale.
  stats_version text not null default '',
  -- Activity, for the "most commented", "latest comment" and "recently
  -- active" sorts. Kept in step by the server on every comment, delete and
  -- edit.
  comment_count integer not null default 0,
  last_comment_at timestamptz,
  last_activity_at timestamptz
);

create index community_plans_user_idx on community_plans (user_id);
create index community_plans_created_at_idx on community_plans (created_at desc);
create index community_plans_score_idx on community_plans (score desc);
create index community_plans_downloads_idx on community_plans (downloads desc);
create index community_plans_views_idx on community_plans (views desc);
create index community_plans_machine_count_idx on community_plans (machine_count desc);
create index community_plans_node_count_idx on community_plans (node_count desc);
create index community_plans_tier_idx on community_plans (highest_tier_index);
create index community_plans_public_idx on community_plans (is_public, created_at desc);
create index community_plans_activity_idx on community_plans (last_activity_at desc);
create index community_plans_comments_idx on community_plans (comment_count desc);

create table community_votes (
  plan_id uuid not null references community_plans (id) on delete cascade,
  voter_key text not null,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (plan_id, voter_key)
);

-- Sliding-window rate limiting, one row per accepted action.
create table community_events (
  id bigint generated always as identity primary key,
  actor_key text not null,
  action text not null,
  created_at timestamptz not null default now()
);

create index community_events_window_idx
  on community_events (actor_key, action, created_at desc);
-- The hourly prune deletes by age alone; the window index leads with
-- actor_key and cannot serve it.
create index community_events_created_at_idx on community_events (created_at);

-- ---------------------------------------------------------------------------
-- BLUEPRINTS: an account's saved sub-assemblies, a captured board selection
-- (cards, wires, pockets, recipes) that can be stamped back into any design.
-- Only the owner reads, edits and deletes one. is_public, description,
-- author_name, published_at, the vote counters, downloads and
-- blueprint_votes are written by no route; the own list carries them in
-- its answers' shape.
create table blueprints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references community_users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  payload jsonb not null,
  node_count integer not null default 0,
  storage_count integer not null default 0,
  edge_count integer not null default 0,
  pocket_count integer not null default 0,
  machine_count integer not null default 0,
  is_public boolean not null default false,
  description text not null default '' check (char_length(description) <= 500),
  author_name text not null default '',
  published_at timestamptz,
  -- The stat card: external needs and unconsumed outputs, computed at save
  -- time from the payload's own sub-plan solve (icons included), so listings
  -- show what a blueprint eats and makes without fetching payloads.
  needs jsonb not null default '[]'::jsonb,
  outputs jsonb not null default '[]'::jsonb,
  -- Author-curated tags, normalized lowercase; tags_text is the same list
  -- space-joined, maintained by the app, so ilike search reaches into tags.
  tags jsonb not null default '[]'::jsonb,
  tags_text text not null default '',
  upvotes integer not null default 0,
  downvotes integer not null default 0,
  score integer generated always as (upvotes - downvotes) stored,
  downloads integer not null default 0,
  created_at timestamptz not null default now(),
  -- The item face the author picked for list rows: {kind, resourceId, icon refs}.
  icon jsonb,
  -- Top voltage tier inside, derived at save time alongside the stat card.
  highest_tier text,
  highest_tier_index integer not null default -1
);

create index blueprints_user_created_idx on blueprints (user_id, created_at desc);
create index blueprints_public_new_idx on blueprints (is_public, published_at desc);
create index blueprints_public_top_idx on blueprints (is_public, score desc);
create index blueprints_public_downloads_idx on blueprints (is_public, downloads desc);

create table blueprint_votes (
  blueprint_id uuid not null references blueprints (id) on delete cascade,
  voter_key text not null,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (blueprint_id, voter_key)
);

-- ---------------------------------------------------------------------------
-- THE LIBRARY: an account's own designs and folders, synced across browsers.
--
-- Ids are minted by the client (the same ids the browser database uses), so
-- a design keeps its id whichever device made it. Rows are never deleted,
-- only tombstoned (deleted_at), so a delete on one device reaches the others
-- instead of being uploaded back by a browser that still holds the copy.
-- Timestamps are the client's: last write wins by the writer's own clock,
-- and the server stores what it is told so both sides agree on "synced".
create table library_folders (
  user_id uuid not null references community_users (id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, id)
);

-- A cloud plan is a library_designs row, addressed as <owner id>:<design id>.
-- Its owner can share it with other accounts as editors; the live service
-- (src/live/) holds an open plan in memory and writes it back in batches.
create table library_designs (
  user_id uuid not null references community_users (id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 80),
  plan jsonb not null,
  icon jsonb,
  folder_id text,
  -- Off the tab strip, in the library only. Synced: closing on one device
  -- closes everywhere.
  closed boolean not null default false,
  sort_order integer,
  community_plan_id text,
  created_at timestamptz not null default now(),
  -- updated_at moves on any change; plan_updated_at only when the plan did,
  -- so a pull can tell a rename from an edit and skip fetching the plan.
  updated_at timestamptz not null default now(),
  plan_updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- A starred design (the built-in Favorites collection).
  favorite boolean not null default false,
  -- How many edit batches the live service has applied to the plan; written
  -- with each flush.
  seq bigint not null default 0,
  -- While this is in the future the live service holds the plan and is its
  -- only writer: the REST plan PUT refuses a plan body (409 {live: true});
  -- metadata still goes through REST.
  live_lease_until timestamptz,
  -- Which lease holds it: a random token the live service writes when it
  -- takes the lease. Every renewal, flush and release is conditional on it,
  -- so a room whose lease another took (or that lapsed and a REST save
  -- cleared it) stops writing instead of overwriting the plan. Cleared with
  -- the lease.
  live_lease_token text,
  -- The plan's stored size: the live service keeps a budget of plan bytes
  -- across the plans it has open and must know a plan's size before reading
  -- it. Postgres keeps the figure; nothing writes it.
  plan_bytes integer generated always as (octet_length(plan::text)) stored,
  primary key (user_id, id)
);

create index library_designs_user_updated_idx
  on library_designs (user_id, updated_at desc);

-- Accounts a design is shared with. (owner_id, design_id) is library_designs'
-- primary key (user_id, id), so the composite reference needs no new unique
-- constraint. Designs are tombstoned rather than deleted, so the server
-- removes a tombstoned design's members itself; the cascade covers account
-- deletion.
create table library_design_members (
  owner_id uuid not null references community_users (id) on delete cascade,
  design_id text not null,
  member_id uuid not null references community_users (id) on delete cascade,
  role text not null default 'editor' check (role in ('editor')),
  added_at timestamptz not null default now(),
  primary key (owner_id, design_id, member_id),
  foreign key (owner_id, design_id) references library_designs (user_id, id) on delete cascade
);

create index library_design_members_member on library_design_members (member_id);

-- ---------------------------------------------------------------------------
-- COMMENTS on shared setups. One row per comment; deleting sets deleted_at
-- so a thread never loses its shape. The author, the post's owner and an
-- admin may delete.
create table community_comments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references community_plans (id) on delete cascade,
  user_id uuid not null references community_users (id) on delete cascade,
  author_name text not null default '',
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index community_comments_plan_idx
  on community_comments (plan_id, created_at);
