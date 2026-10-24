-- EVENTS PRUNE.
--
-- community_events is pruned by age (rows older than the longest window the
-- limits read are deleted once an hour by the site), and the prune filters on
-- created_at alone. The only other index leads with actor_key, so without this
-- one each prune reads the whole table. Additive and idempotent; apply any
-- time. Mirrored at the end of supabase/schema.sql.
create index if not exists community_events_created_at_idx on community_events (created_at);
