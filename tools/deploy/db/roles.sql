-- The roles PostgREST works with, idempotent (run on every deploy).
-- service_role: what the site's and the live service's token names; it
--   bypasses row security, as on the hosted project, and cannot log in.
-- authenticator: PostgREST's login, which switches to the token's role and
--   holds no rights of its own (noinherit).
-- There is no anon role: a request without a token is refused.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end
$$;

alter role service_role nologin bypassrls;
alter role authenticator login noinherit;
grant service_role to authenticator;
-- psql fills this in from -v authenticator_password=...; outside a dollar
-- quote, where psql variables are expanded.
alter role authenticator with password :'authenticator_password';
