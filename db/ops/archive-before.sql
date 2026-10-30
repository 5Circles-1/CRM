-- ---------------------------------------------------------------------------
-- Park everything older than a cutoff date, so the floor works current data.
--
-- WHAT THIS IS FOR
--
-- The owner's rule: the working CRM carries the data from the current launch
-- (14 August 2026) onwards. Anything older clutters every pipeline, feeds the
-- alert bell with ancient follow-ups, and slows the screens down - "overload".
--
-- WHAT IT DOES
--
-- Leads created before the cutoff AND not touched since it are PARKED, not
-- deleted: status -> nurture, pool -> previous_month. Parked leads
--   - leave My Pipeline, Fresh leads and every alert,
--   - stop counting as leakage or overdue,
--   - stay in Find lead and the Previous months tab, and can be picked back
--     into work with one click (Pick up & work) if they ever call again.
--
-- Nothing is hard-deleted, matching the schema's rule that the application
-- never destroys a lead. Paying clients are untouched: any lead with a deal,
-- and any lead worked since the cutoff, stays exactly where it is.
--
-- HOW TO RUN
--
-- Prefer the button: Admin -> Data does the same thing with a preview count
-- (crm.archive_leads_before, migration 0050). This script is the psql way in,
-- for when the UI is unreachable:
--
--   sudo -u postgres psql -d crm -f /opt/crm/db/ops/archive-before.sql
--
-- To use a different cutoff:
--
--   sudo -u postgres psql -d crm -v cutoff='2026-09-01' -f .../archive-before.sql
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

\if :{?cutoff}
\else
  \set cutoff '2026-08-15'
\endif

begin;

-- What is about to move, so the commit is informed.
select count(*) as leads_about_to_park
  from crm.leads l
 where l.created_at < (:'cutoff'::date)::timestamp at time zone 'Asia/Kolkata'
   and coalesce(l.last_contacted_at, l.created_at)
         < (:'cutoff'::date)::timestamp at time zone 'Asia/Kolkata'
   and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
   and l.pool is distinct from 'previous_month'
   and not exists (select 1 from crm.deals d where d.lead_id = l.id);

-- Their pending callbacks are cancelled (not deleted): a callback for a
-- parked lead would keep ringing the bell forever.
update crm.callbacks c
   set status = 'cancelled', updated_at = now()
 where c.status = 'pending'
   and c.lead_id in (
     select l.id from crm.leads l
      where l.created_at < (:'cutoff'::date)::timestamp at time zone 'Asia/Kolkata'
        and coalesce(l.last_contacted_at, l.created_at)
              < (:'cutoff'::date)::timestamp at time zone 'Asia/Kolkata'
        and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
        and l.pool is distinct from 'previous_month'
        and not exists (select 1 from crm.deals d where d.lead_id = l.id));

-- Park, and stamp each lead's history in the same statement - the 'archived'
-- event is what clears an undialled re-enquiry on a parked lead (0086), so
-- parking without it would leave the fresh list still showing them.
with parked as (
  update crm.leads l
     set status           = 'nurture',
         pool             = 'previous_month',
         next_action_at   = null,
         next_action_note = 'Archived - created before ' || :'cutoff',
         reminder_at      = null,
         updated_at       = now()
   where l.created_at < (:'cutoff'::date)::timestamp at time zone 'Asia/Kolkata'
     and coalesce(l.last_contacted_at, l.created_at)
           < (:'cutoff'::date)::timestamp at time zone 'Asia/Kolkata'
     and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
     and l.pool is distinct from 'previous_month'
     and not exists (select 1 from crm.deals d where d.lead_id = l.id)
   returning l.id
)
insert into crm.lead_events (lead_id, event_type, payload)
select p.id, 'archived', jsonb_build_object('cutoff', :'cutoff', 'via', 'ops_script')
  from parked p;

-- Retire the pre-cutoff re-enquiries the park cannot reach (0087): closed
-- leads, paying clients, anything shielded by a deal. The sale and the close
-- are untouched; only the "call them back" flag is marked handled. A
-- re-enquiry at or after the cutoff stays - current work, not history.
insert into crm.lead_events (lead_id, event_type, payload)
select le.lead_id, 'reenquiry_archived',
       jsonb_build_object('cutoff', :'cutoff', 'via', 'ops_script')
  from (select distinct on (e.lead_id) e.lead_id, e.occurred_at
          from crm.lead_events e
         where e.event_type = 're_enquiry'
         order by e.lead_id, e.occurred_at desc) le
  join crm.leads l on l.id = le.lead_id
 where le.occurred_at < (:'cutoff'::date)::timestamp at time zone 'Asia/Kolkata'
   and not exists (select 1 from crm.call_attempts ca
                    where ca.lead_id = le.lead_id
                      and ca.started_at > le.occurred_at)
   and (l.closed_at is null or l.closed_at <= le.occurred_at)
   and not exists (select 1 from crm.lead_events ae
                    where ae.lead_id = le.lead_id
                      and ae.event_type in ('archived', 'reenquiry_archived')
                      and ae.occurred_at > le.occurred_at);

-- Proof, in the same transaction.
select
  (select count(*) from crm.leads where pool = 'previous_month') as parked_total,
  (select count(*) from crm.leads
    where status in ('new', 'working', 'callback') and pool is null) as still_live,
  (select count(*) from crm.v_reenquired_leads) as reenquiries_still_waiting;

commit;
