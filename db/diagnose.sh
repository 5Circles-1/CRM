#!/usr/bin/env bash
#
# Why are no leads arriving?
#
# Run this ON THE SERVER when the sheet has rows the CRM does not:
#
#     ssh root@<server>
#     cd /opt/crm && bash db/diagnose.sh
#
# It is read-only - it changes nothing, so it is always safe to run - and it
# answers the questions that distinguish the real causes from each other:
#
#   1. Is the importer even configured? (the scheduled sync starts only when
#      SERVICE_USER_ID and Google credentials are both present; otherwise the
#      app runs happily and imports nothing on its own)
#   2. What did the last runs actually do - and did they error?
#   3. If rows arrived but no leads appeared, why were they quarantined?
#   4. Are the sources still connected to a sheet at all?
#   5. Are fresh leads being assigned, or parking unassigned?
set -euo pipefail

DB="${CRM_DB:-crm}"
ENV_FILE="${ENV_FILE:-/opt/crm/api/.env}"

psql_q() {
  sudo -u postgres psql -v ON_ERROR_STOP=0 -P pager=off -d "$DB" "$@"
}

rule() {
  echo
  echo "================ $1"
}

rule "1. IS THE SCHEDULED IMPORTER CONFIGURED?"
if [[ -f "$ENV_FILE" ]]; then
  for key in SERVICE_USER_ID GOOGLE_SERVICE_ACCOUNT_JSON GOOGLE_APPLICATION_CREDENTIALS; do
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
      echo "  ${key}: set"
    else
      echo "  ${key}: NOT SET"
    fi
  done
  echo "  (scheduled sync needs SERVICE_USER_ID plus one of the GOOGLE_* keys;"
  echo "   without them, only Admin -> Sync now and CSV import bring leads in)"
else
  echo "  ${ENV_FILE} not found - set ENV_FILE=... if the app lives elsewhere"
fi

rule "2. THE LAST TEN INGESTION RUNS"
psql_q -c "select s.name as source,
                  r.started_at at time zone 'Asia/Kolkata' as started_ist,
                  r.rows_seen, r.rows_created, r.rows_duplicate, r.rows_quarantined,
                  coalesce(left(r.error_text, 60), '-') as error
             from crm.ingestion_runs r
             join crm.lead_sources s on s.id = r.source_id
            order by r.started_at desc limit 10;"

rule "3. WHY ROWS WERE QUARANTINED (most recent first)"
psql_q -c "select s.name as source, i.reject_reason, count(*) as rows,
                  max(i.created_at) at time zone 'Asia/Kolkata' as latest_ist
             from crm.ingested_rows i
             join crm.lead_sources s on s.id = i.source_id
            where i.status = 'quarantined'
            group by s.name, i.reject_reason
            order by latest_ist desc limit 10;"

rule "4. SOURCES AND THEIR CONNECTION"
psql_q -c "select name, is_active,
                  (spreadsheet_id is not null) as sheet_connected,
                  coalesce(worksheet_name, '-') as tab,
                  last_synced_at at time zone 'Asia/Kolkata' as last_sync_ist
             from crm.lead_sources order by name;"

rule "5. TODAY'S LEADS, AND WHO GOT THEM"
psql_q -c "select coalesce(u.full_name, 'UNASSIGNED') as assigned_to,
                  count(*) as leads_today
             from crm.leads l
             left join crm.users u on u.id = l.assigned_to
            where crm.ist_date(l.created_at) = crm.ist_date(now())
            group by 1 order by 2 desc;"
psql_q -c "select count(*) as open_unassigned_total
             from crm.leads
            where stage in ('new','calling','qualified') and assigned_to is null;"

echo
echo "Nothing here changed any data. Send this whole output back."
