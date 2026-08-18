#!/usr/bin/env bash
#
# Print the Google address a spreadsheet must be shared with.
#
#     ssh root@<server>
#     cd /opt/crm && bash db/google-address.sh
#
# Read-only. It prints the service account's client_email and nothing else -
# the private key sitting beside it in the same file is never read, never
# printed, and must never be shared with anybody.
#
# This exists because "the caller does not have permission" - Google's way of
# saying the sheet is not shared with the CRM - cost the floor two days, and
# the address needed to fix it was buried in a credentials file.

set -u

echo
echo "=============================================================="
echo " The CRM reads Google Sheets as this account."
echo " Share the sheet with the address below, as a VIEWER."
echo "=============================================================="
echo

found=""

# 1. A credentials file, wherever it is configured to live.
for f in "${GOOGLE_APPLICATION_CREDENTIALS:-}" \
         /opt/crm/api/google-sa.json \
         /opt/crm/google-sa.json \
         /etc/crm/google-sa.json; do
  [ -n "$f" ] && [ -r "$f" ] || continue
  email=$(tr -d '\n' < "$f" | grep -o '"client_email"[[:space:]]*:[[:space:]]*"[^"]*"' \
          | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  if [ -n "${email:-}" ]; then
    echo "   $email"
    echo
    echo "   (found in $f)"
    found=yes
    break
  fi
done

# 2. Or the credentials pasted inline into the environment file.
if [ -z "$found" ] && [ -r /opt/crm/api/.env ]; then
  email=$(grep -o '"client_email"[[:space:]]*:[[:space:]]*\\*"[^"\\]*' /opt/crm/api/.env \
          | head -1 | sed 's/.*[":\\ ]\([^":\\ ]*@[^":\\ ]*\)$/\1/')
  if [ -n "${email:-}" ]; then
    echo "   $email"
    echo
    echo "   (found in /opt/crm/api/.env)"
    found=yes
  fi
fi

if [ -z "$found" ]; then
  echo "   COULD NOT FIND ONE."
  echo
  echo "   No Google credentials are configured on this server, which means"
  echo "   the CRM cannot read any sheet at all. Files checked:"
  echo "     ${GOOGLE_APPLICATION_CREDENTIALS:-(GOOGLE_APPLICATION_CREDENTIALS not set)}"
  echo "     /opt/crm/api/google-sa.json"
  echo "     /opt/crm/api/.env  (inline GOOGLE_SERVICE_ACCOUNT_JSON)"
  echo
  echo "   Send this output back - the fix is a credentials file, not sharing."
  exit 1
fi

cat <<'HOWTO'

   Next, in Google Sheets:
     1. Open the lead sheet
     2. Press  Share  (top right)
     3. Paste the address above
     4. Set it to  Viewer , untick "Notify people", press  Send

   Within five minutes every waiting lead imports and distributes across
   both teams. To pull them immediately instead, open the CRM, go to
   Floor, and press "Import the sheet now".

HOWTO
