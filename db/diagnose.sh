#!/usr/bin/env bash
#
# Why are no leads arriving?
#
# Run this ON THE SERVER when the sheet has rows the CRM does not:
#
#     ssh root@<server>
#     cd /opt/crm && sudo -u crm git pull && bash db/diagnose.sh
#
# It is read-only - it changes nothing, so it is always safe to run - and it
# answers the four questions that distinguish the real causes from each other:
#
#   1. Is the importer even running? (it starts only when SERVICE_USER_ID and
#      Google credentials are both present; otherwise the app runs happily and
#      imports nothing)
#   2. What did the last runs actually do - and did they error?
#   3. If rows arrived but no leads appeared, why were they rejected?
#   4. Are the sources still connected to a sheet at all?
#
# Deliberately not a one-liner over ssh: quoting a query through PowerShell
# mangles it before it ever reaches the server.

set -u
DB="${CRM_DB:-crm}"

psql_q() { sudo -u postgres psql -d "$DB" -X -q "$@" 2>&1; }
rule()   { printf '\n=== %s ===\n' "$1"; }

echo "5 Circles CRM - lead intake diagnosis"
echo "server: $(hostname)   database: $DB   time: $(date '+%Y-%m-%d %H:%M:%S %Z')"

rule "1. IS THE SERVICE UP?"
systemctl is-active crm && systemctl show crm -p ActiveEnterTimestamp --value

rule "2. IS THE IMPORTER CONFIGURED?"
# The two switches that silently disable everything. Values are never printed -
# only whether they are set - so this is safe to paste into a chat.
for var in SERVICE_USER_ID GOOGLE_SERVICE_ACCOUNT_JSON GOOGLE_APPLICATION_CREDENTIALS; do
  if grep -qE "^${var}=." /opt/crm/api/.env 2>/dev/null; then
    echo "  $var .......... SET"
  else
    echo "  $var .......... MISSING  <-- while missing, nothing is imported automatically"
  fi
done

rule "3. WHAT THE APP SAID (last 3 days)"
journalctl -u crm --since '3 days ago' --no-pager 2>/dev/null \
  | grep -iE 'sheet sync|background jobs|SERVICE_USER_ID|google|ingest' \
  | tail -20
echo "(no lines above means the importer never logged anything at all)"

rule "4. LAST IMPORT RUNS"
psql_q -c "select r.started_at at time zone 'Asia/Kolkata' as ist_time,
                  s.name as source, r.rows_seen, r.rows_created,
                  r.rows_duplicate as matched_existing, r.rows_quarantined as rejected,
                  coalesce(left(r.error_text, 90), '-') as error
             from crm.ingestion_runs r
             join crm.lead_sources s on s.id = r.source_id
            order by r.started_at desc limit 10;"

rule "5. WHY ROWS WERE REJECTED (last 4 days)"
psql_q -c "select coalesce(reject_reason, '(accepted)') as reason, count(*)
             from crm.ingested_rows
            where created_at > now() - interval '4 days'
            group by 1 order by 2 desc limit 10;"

rule "6. LEADS CREATED PER DAY (last 7 days, IST)"
psql_q -c "select crm.ist_date(created_at) as ist_day, count(*) as leads
             from crm.leads
            where created_at > now() - interval '7 days'
            group by 1 order by 1;"

rule "7. SOURCES AND THEIR CONNECTION"
psql_q -c "select name, is_active,
                  (spreadsheet_id is not null) as sheet_connected,
                  coalesce(worksheet_name, '-') as tab,
                  last_synced_at at time zone 'Asia/Kolkata' as last_sync_ist
             from crm.lead_sources order by name;"

rule "8. INTAKE HEALTH (as the Floor tab now shows it)"
psql_q -c "select source_name, state, created_today, quarantined_today,
                  coalesce(minutes_since_sync::text, 'never') as mins_since_sync
             from crm.v_intake_health order by state, source_name;" \
  || echo "(this view arrives with migration 0047 - deploy first)"

rule "9. IS THE BACKGROUND ENGINE ALIVE?"
psql_q -c "select name, last_run_at at time zone 'Asia/Kolkata' as last_run_ist,
                  coalesce(left(last_error, 60), '-') as last_error, run_count
             from crm.job_runs order by last_run_at desc limit 8;" \
  || echo "(this table arrives with migration 0047 - deploy first)"

rule "10. QUARANTINED ROWS WAITING TO BE REPLAYED"
psql_q -c "select count(*) as rows_held_for_fixing
             from crm.ingested_rows where status = 'quarantined';"

echo
echo "Nothing here changed any data. Send this whole output back."
