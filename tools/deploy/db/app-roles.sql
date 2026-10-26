-- The site's and the live service's own database logins, idempotent (run on
-- every deploy, after grants.sql). Each holds only what its process uses:
--
-- gtnh_site: reads and writes the rows of every app table; no DDL, no
--   role, nothing outside these tables.
-- gtnh_live: the columns the live store reads and writes
--   (src/live/store.ts over repos/designs, design-members and accounts):
--   the session account's id, name, admin flag and epoch; a design's
--   members; a design's key, plan, seq, size, tombstone and lease, and
--   writes of the plan, its stamps and the lease. Nothing else, so a
--   compromised live service cannot read password hashes or rename designs.
--
-- Every grant is revoked and given again in one transaction, so a grant
-- removed from this file is gone after the next run and nothing sees the
-- roles without their rights in between. Access to rows is the services'
-- rules; row security is off (supabase/migrations/2026-10-26-row-security-off.sql).
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gtnh_site') then
    create role gtnh_site nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'gtnh_live') then
    create role gtnh_live nologin;
  end if;
end
$$;

alter role gtnh_site nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
alter role gtnh_live nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

-- psql only (db-roles.test.ts leaves out the lines that start with a
-- backslash or read a psql variable, so its roles stay nologin). The
-- passwords come from the environment, never psql's command line: a
-- container's argv shows in the host's process list to every local account.
-- A failing statement is logged with its text by default
-- (log_min_error_statement = error), which here would be the password:
-- for the rest of this transaction no statement text reaches the log.
set local log_min_error_statement = panic;
set local log_statement = 'none';
\getenv site_password GTNH_SITE_DB_PASSWORD
\getenv live_password GTNH_LIVE_DB_PASSWORD
alter role gtnh_site with login password :'site_password';
alter role gtnh_live with login password :'live_password';

-- No role but the owner makes objects in public (Postgres 15's default, said
-- here), and no role makes temporary tables either: the app roles hold no
-- DDL at all, and nothing in the stack uses temporary tables.
revoke create on schema public from public;
do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
end
$$;
grant usage on schema public to gtnh_site, gtnh_live;

revoke all on all tables in schema public from gtnh_site, gtnh_live;
revoke all on all sequences in schema public from gtnh_site, gtnh_live;

grant select, insert, update, delete on
  community_users,
  community_plans,
  community_votes,
  community_events,
  community_comments,
  blueprints,
  blueprint_votes,
  library_folders,
  library_designs,
  library_design_members
to gtnh_site;
-- community_events.id is an identity column.
grant usage on all sequences in schema public to gtnh_site;

grant select (id, username, is_admin, session_epoch) on community_users to gtnh_live;
grant select on library_design_members to gtnh_live;
grant select (user_id, id, plan, seq, plan_bytes, deleted_at, live_lease_until, live_lease_token)
  on library_designs to gtnh_live;
grant update (plan, seq, plan_updated_at, updated_at, live_lease_until, live_lease_token)
  on library_designs to gtnh_live;

commit;
