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
--
-- Each table is altered only while row security is on: the alter takes an
-- access exclusive lock, and a deploy that met a long transaction on a table
-- would hold every query on it behind the waiting lock. Once off, a run
-- takes no table lock.
do $$
declare
  table_name text;
begin
  if exists (select 1 from pg_roles where rolname in ('anon', 'authenticated')) then
    raise exception 'row-security-off: this database has Supabase''s anon or authenticated role, whose API row security guards; not applied';
  end if;
  for table_name in
    select c.relname
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
      and c.relrowsecurity
      and c.relname in (
        'community_users', 'community_plans', 'community_votes', 'community_events',
        'community_comments', 'blueprints', 'blueprint_votes', 'library_folders',
        'library_designs', 'library_design_members'
      )
  loop
    execute format('alter table public.%I disable row level security', table_name);
  end loop;
end
$$;
