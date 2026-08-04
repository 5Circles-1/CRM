#!/usr/bin/env bash
# Nightly database backup.
#
# Runs as the postgres OS user: Ubuntu authenticates local connections by
# peer, so no other account can pg_dump without a password. Install:
#
#   sudo mkdir -p /var/backups/crm
#   sudo chown postgres:postgres /var/backups/crm
#   echo "30 21 * * * /opt/crm/deploy/backup.sh" | sudo -u postgres crontab -
#
# (21:30 UTC = 03:00 IST, after the floor is long closed.)
#
# KEEP COPIES OFF THIS MACHINE. A backup on the server it protects is not a
# backup - sync the directory to object storage or another box.
set -euo pipefail

DIR=${CRM_BACKUP_DIR:-/var/backups/crm}
DB=${CRM_DB:-crm}
STAMP=$(date +%Y-%m-%d)
PARTIAL="$DIR/.crm-$STAMP.partial"
OUT="$DIR/crm-$STAMP.dump"

mkdir -p "$DIR"

# Write to a partial file first. A half-finished dump carrying today's name is
# worse than no dump at all: it looks like a backup right up until the day you
# need it. Only publish once pg_dump has actually succeeded.
pg_dump -Fc -d "$DB" -f "$PARTIAL"

if [ ! -s "$PARTIAL" ]; then
  echo "crm backup FAILED: pg_dump produced an empty file; keeping the previous $OUT" >&2
  rm -f "$PARTIAL"
  exit 1
fi

mv "$PARTIAL" "$OUT"

# Keep 14 days locally. Deliberately after the successful move, so a failed run
# never prunes the good copies it has just failed to replace.
find "$DIR" -name 'crm-*.dump' -mtime +14 -delete

echo "crm backup ok: $OUT ($(du -h "$OUT" | cut -f1))"

# Restore drill - run quarterly, on a scratch database, so you KNOW the backups
# work rather than assuming it:
#   sudo -u postgres createdb crm_restore_test
#   sudo -u postgres pg_restore -d crm_restore_test /var/backups/crm/crm-<date>.dump
#   sudo -u postgres psql -d crm_restore_test -c "select count(*) from crm.leads;"
#   sudo -u postgres dropdb crm_restore_test
