-- What the service role may touch: everything in public, now and for tables
-- later migrations create. Row security stays on with no policies; the
-- service role bypasses it and no other role reaches the API.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
