#!/bin/sh
# The database's setup, run by the deploy on every deploy (the migrate image's
# command): the roles, the schema, every migration in name order, the grants,
# then a schema reload for PostgREST. Every file is idempotent and additive,
# as the local database's every-open load assumes, so a second run changes
# nothing. Connection: PGHOST, PGUSER, PGPASSWORD; the authenticator's
# password: POSTGREST_AUTHENTICATOR_PASSWORD, which roles.sql reads from the
# environment (never on a command line).
set -eu

: "${POSTGREST_AUTHENTICATOR_PASSWORD:?POSTGREST_AUTHENTICATOR_PASSWORD is not set}"
root=/deploy
# A rerun's "already exists, skipping" notices are the idempotency working, not news.
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

apply() {
  echo "migrate: $1"
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -f "$root/$1"
}

apply db/roles.sql
apply schema.sql
for file in $(cd "$root" && LC_ALL=C ls migrations/*.sql | LC_ALL=C sort); do
  apply "$file"
done
apply db/grants.sql
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "notify pgrst, 'reload schema'"
echo "migrate: done"
