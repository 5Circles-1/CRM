#!/usr/bin/env bash
# Drop and rebuild the development database from migrations + seed.
# Forward-only migrations, applied in filename order.
#
#   PGHOST=/tmp PGPORT=55432 ./db/rebuild.sh [--with-tests]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${CRM_DB:-crm_dev}"
PSQL=(psql -v ON_ERROR_STOP=1 --quiet -U "${PGUSER:-postgres}")

echo "==> dropping and recreating ${DB}"
"${PSQL[@]}" -d postgres -c "drop database if exists ${DB} with (force);" >/dev/null
"${PSQL[@]}" -d postgres -c "create database ${DB};" >/dev/null

echo "==> applying migrations"
for f in "${HERE}"/migrations/*.sql; do
  printf '    %s\n' "$(basename "$f")"
  "${PSQL[@]}" -d "${DB}" -f "$f" >/dev/null
done

echo "==> seeding"
"${PSQL[@]}" -d "${DB}" -f "${HERE}/seed/seed.sql" >/dev/null

if [[ "${1:-}" == "--with-tests" ]]; then
  echo "==> running tests"
  "${PSQL[@]}" -d "${DB}" -f "${HERE}/tests/test_requirements.sql"
fi

echo "==> done"
