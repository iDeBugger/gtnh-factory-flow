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
-- Read from the environment, never from psql's command line: a container's
-- argv shows in the host's process list to every local account. Used outside
-- a dollar quote, where psql variables are expanded.
-- In its own transaction with statement logging off: a failing statement is
-- logged with its text by default, which here would be the password.
begin;
set local log_min_error_statement = panic;
set local log_statement = 'none';
\getenv authenticator_password POSTGREST_AUTHENTICATOR_PASSWORD
alter role authenticator with password :'authenticator_password';
commit;
