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
--   sudo -u postgres psql -d crm -f /opt/crm/db/ops/archive-before.sql
--
-- To use a different cutoff:
--
--   sudo -u postgres psql -d crm -v cutoff='2026-09-01' -f .../archive-before.sql
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

\if :{?cutoff}
\else
  \set cutoff '2026-08-14'
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
   and not exists (select 1 from crm.deals d where d.lead_id = l.id);

-- Proof, in the same transaction.
select
  (select count(*) from crm.leads where pool = 'previous_month') as parked_total,
  (select count(*) from crm.leads
    where status in ('new', 'working', 'callback') and pool is null) as still_live;

commit;
