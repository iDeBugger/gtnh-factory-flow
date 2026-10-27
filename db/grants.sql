-- What the site's and the live service's logins may touch, applied by the
-- migration runner on every run inside the transaction that ensures the
-- roles (ensureRoles in src/lib/server/db/migrations.ts). Each holds only
-- what its process uses:
--
-- gtnh_site: reads and writes the rows of every app table; no DDL, no role,
--   nothing outside these tables, and not the migration ledger.
-- gtnh_live: the columns the live store reads and writes
--   (src/live/store.ts over repos/designs, design-members and accounts):
--   the session account's id, name, admin flag and epoch; a design's
--   members; a design's key, plan, seq, size, tombstone and lease, and
--   writes of the plan, its stamps and the lease. Nothing else, so a
--   compromised live service cannot read password hashes or rename designs.
--
-- Every grant is revoked and given again, so a grant removed from this file
-- is gone after the next run. Access to rows is the services' rules; row
-- security is off. A new table gets its line here in the commit that adds it.

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
