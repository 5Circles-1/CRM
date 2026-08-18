#!/usr/bin/env bash
# Bring the live CRM up to date with the repository - one command:
#
#   sudo /opt/crm/deploy/update.sh
#
# In order, stopping loudly at the first problem:
#   1. pull the latest code (fast-forward only - refuses surprises)
#   2. reinstall dependencies only if the lockfile actually changed
#   3. apply any new database migrations (each recorded, never re-run)
#   4. restart the service and prove it came back
#
# Safe to run any time, including when there is nothing new: every step is a
# no-op when it has nothing to do. This never touches the data - migrations
# are forward-only files reviewed in the repository, and db/migrate.sh skips
# every one it has already applied.

set -euo pipefail

# The whole body lives in main() so that bash has finished reading this file
# before the pull below replaces it - a script that updates itself must not
# be half-read old and half-read new.
main() {
  local app=/opt/crm

  if [[ $EUID -ne 0 ]]; then
    echo "run with sudo: sudo $app/deploy/update.sh" >&2
    exit 1
  fi

  cd "$app"
  local before after
  before=$(sudo -u crm git rev-parse HEAD)
  echo "==> pulling latest code"
  sudo -u crm git pull --ff-only
  after=$(sudo -u crm git rev-parse HEAD)

  if [[ "$before" == "$after" ]]; then
    echo "==> already up to date (${before:0:7})"
  fi

  if ! sudo -u crm git diff --quiet "$before" "$after" -- api/package-lock.json; then
    echo "==> dependencies changed - reinstalling"
    (cd "$app/api" && sudo -u crm npm ci --omit=dev)
  fi

  echo "==> applying new database migrations"
  sudo -u postgres CRM_DB=crm "$app/db/migrate.sh"

  echo "==> restarting the service"
  systemctl restart crm
  sleep 2
  if systemctl --quiet is-active crm; then
    echo "==> crm is running - update complete (${before:0:7} -> ${after:0:7})"
  else
    echo "!! crm did not come back - read the last lines with: journalctl -u crm -n 50" >&2
    exit 1
  fi
}

main "$@"
