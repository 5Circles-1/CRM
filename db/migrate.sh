#!/usr/bin/env bash
# Apply pending migrations, in filename order, exactly once each.
#
# This is the PRODUCTION migration runner. Unlike rebuild.sh it never drops
# anything: applied files are recorded in public.schema_migrations and skipped
# on the next run, so calling this after every update is always safe.
#
#   CRM_DB=crm PGHOST=... PGUSER=postgres ./db/migrate.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${CRM_DB:-crm}"
PSQL=(psql -v ON_ERROR_STOP=1 --quiet -d "${DB}")

"${PSQL[@]}" -c "
  create table if not exists public.schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now()
  );"

applied=0
for f in "${HERE}"/migrations/*.sql; do
  base="$(basename "$f")"
  seen="$("${PSQL[@]}" -tAc "select 1 from public.schema_migrations where filename = '${base}'")"
  if [[ "${seen}" == "1" ]]; then
    continue
  fi
  echo "==> applying ${base}"
  # File + bookkeeping row in ONE transaction: a crash mid-file leaves the
  # migration unrecorded and it re-runs cleanly next time.
  "${PSQL[@]}" --single-transaction \
    -f "$f" \
    -c "insert into public.schema_migrations (filename) values ('${base}');"
  applied=$((applied + 1))
done

echo "==> up to date (${applied} applied this run)"
