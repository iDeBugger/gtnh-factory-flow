-- THE STORED SIZE OF A PLAN.
--
-- The live service holds a budget of plan bytes across the plans it has open
-- and must know a plan's size before reading it, or every plan being opened
-- would have to count as the biggest one allowed. Postgres keeps the figure
-- with the row; nothing writes it. Additive and idempotent; the code before
-- this never reads the column. Mirrored at the end of supabase/schema.sql.
alter table library_designs
  add column if not exists plan_bytes integer
  generated always as (octet_length(plan::text)) stored;
