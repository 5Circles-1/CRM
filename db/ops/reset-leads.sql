-- ---------------------------------------------------------------------------
-- Clear the lead book and start the floor from zero.
--
-- WHAT THIS IS FOR
--
-- The first sync of a Google Sheet reads the WHOLE sheet, not the part of it
-- that arrived today. A sheet with months of history therefore lands months of
-- history in the CRM, and the floor opens on a thousand leads nobody is going
-- to call. This empties the lead book so the pilot starts on today's leads.
--
-- WHAT IT DELIBERATELY DOES NOT DELETE
--
-- crm.ingested_rows is KEPT. That table is the record of which sheet rows have
-- already been seen, and it is what stops the next sync putting all of history
-- straight back. Deleting the leads while keeping that record is the whole
-- trick: rows already in the sheet are known and skipped, rows appended from
-- now on are new and become leads.
--
-- Users, teams, memberships, products, settings, attendance and the audit log
-- are untouched. Only leads and everything downstream of a lead go.
--
-- THIS IS NOT REVERSIBLE. Take a backup first:
--   sudo /opt/crm/deploy/backup.sh
--
-- Run as the table owner (postgres). crm_app has DELETE revoked by design.
--   sudo -u postgres psql -d crm -f /opt/crm/db/ops/reset-leads.sql
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

begin;

-- One transaction. A reset that half-happened would be worse than either
-- outcome: leads gone, money rows still pointing at them.

-- lead_events and call_attempts are append-only, enforced by a BEFORE DELETE
-- trigger. A cascade from crm.leads performs a real DELETE on those tables, so
-- the trigger fires and aborts the whole thing. Disabling them for the length
-- of this transaction is the point of running as owner - it is not a way round
-- the rule, it is the one operation the rule was never meant to cover.
alter table crm.lead_events   disable trigger lead_events_append_only;
alter table crm.call_attempts disable trigger call_attempts_append_only;

-- Money first: deals hold leads with ON DELETE RESTRICT, and payments hold
-- deals the same way. Nothing here should exist during a pilot reset; if it
-- does, the count below is your warning that you are deleting real revenue.
select count(*) as deals_about_to_be_deleted from crm.deals;

delete from crm.payments;
delete from crm.promises_to_pay;
delete from crm.instalments;
delete from crm.handoff_outbox;
delete from crm.deals;

-- The lead book. Cascades take lead_events, call_attempts, callbacks,
-- lead_transfers and distribution_events with it.
delete from crm.leads;

-- lead_access_log carries a bare lead_id with no foreign key, so it is not
-- cascaded. Left in place on purpose: it is the security record of who looked
-- at what, and it should outlive the rows it describes.

-- ingested_rows keeps its rows but loses its pointers, since the leads they
-- pointed at are gone. The (source_id, source_row_key, payload_hash) identity
-- is what matters and that is untouched.
update crm.ingested_rows set lead_id = null where lead_id is not null;

-- Distribution cursors are reset so rotation starts clean rather than
-- resuming mid-cycle against a team that no longer has pending work.
delete from crm.distribution_cursors;

alter table crm.lead_events   enable trigger lead_events_append_only;
alter table crm.call_attempts enable trigger call_attempts_append_only;

-- Proof, in the same transaction, before anyone commits anything.
select
  (select count(*) from crm.leads)          as leads,
  (select count(*) from crm.deals)          as deals,
  (select count(*) from crm.callbacks)      as callbacks,
  (select count(*) from crm.ingested_rows)  as sheet_rows_remembered;

commit;
