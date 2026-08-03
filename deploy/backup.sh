#!/usr/bin/env bash
# Nightly database backup. Install as the crm user's cron:
#   crontab -e   ->   30 21 * * * /opt/crm/deploy/backup.sh
# (21:30 UTC = 03:00 IST, after the floor is long closed.)
#
# KEEP COPIES OFF THIS MACHINE. A backup on the server it protects is not a
# backup - sync the directory to object storage or another box.
set -euo pipefail
DIR=/var/backups/crm
mkdir -p "$DIR"
STAMP=$(date +%Y-%m-%d)
pg_dump -Fc -d crm > "$DIR/crm-$STAMP.dump"
# Keep 14 days locally.
find "$DIR" -name 'crm-*.dump' -mtime +14 -delete
# Restore drill (run quarterly, on a scratch database, so you KNOW it works):
#   createdb crm_restore_test && pg_restore -d crm_restore_test "$DIR/crm-<date>.dump"
