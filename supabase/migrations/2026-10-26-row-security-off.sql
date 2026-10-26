-- ROW SECURITY OFF.
--
-- Who may read and write which rows is the server's rules
-- (src/lib/server/services/access.ts, applied in SQL by repos/visibility.ts)
-- and the roles' grants (tools/deploy/db/app-roles.sql). Row security with no
-- policies would hide every row from a role without bypassrls, which the
-- site's and the live service's own roles (gtnh_site, gtnh_live) are not.
-- PostgREST's service_role bypasses row security, so it reads and writes as
-- before. Idempotent; apply any time after schema.sql.
--
-- Refused on a database that serves Supabase's API roles (anon,
-- authenticated): there row security with no policies is what keeps every
-- table away from the public API key.
do $$
begin
  if exists (select 1 from pg_roles where rolname in ('anon', 'authenticated')) then
    raise exception 'row-security-off: this database has Supabase''s anon or authenticated role, whose API row security guards; not applied';
  end if;
end
$$;

alter table community_users disable row level security;
alter table community_plans disable row level security;
alter table community_votes disable row level security;
alter table community_events disable row level security;
alter table community_comments disable row level security;
alter table blueprints disable row level security;
alter table blueprint_votes disable row level security;
alter table library_folders disable row level security;
alter table library_designs disable row level security;
alter table library_design_members disable row level security;
