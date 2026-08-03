-- 0014_engine_authority.sql
--
-- The engine functions are run from the scheduler as the ops service account,
-- through crm_app, under RLS. Several of them must cross RLS boundaries that
-- are deliberately tight for humans:
--
--   - the payment trigger rolls amounts onto instalments and settles promises
--   - security detection reads the access log (admin-only) and raises alerts
--   - score snapshots write a row for every caller and counsellor
--   - callback expiry closes callbacks belonging to other users
--
-- Run as the invoker, these silently under-execute: RLS filters rows before
-- the statement acts, so an update simply affects zero rows and reads as
-- success - the same failure mode 0012 closed for append-only tables, found
-- again here by the API test that books a deal and pays an instalment (the
-- promise was never marked kept).
--
-- These are system invariants, not user actions, so they become SECURITY
-- DEFINER with a pinned search_path. Authority-checking functions
-- (crm.transfer_lead) deliberately stay invoker-rights: their whole point is
-- to act as, and be limited by, the person calling them.

alter function crm.tg_payment_apply()           security definer set search_path = crm, pg_temp;
alter function crm.mark_overdue_instalments()   security definer set search_path = crm, pg_temp;
alter function crm.expire_missed_callbacks()    security definer set search_path = crm, pg_temp;
alter function crm.snapshot_scores(date)        security definer set search_path = crm, pg_temp;
alter function crm.detect_bulk_access()         security definer set search_path = crm, pg_temp;
alter function crm.detect_off_hours_access()    security definer set search_path = crm, pg_temp;

-- Definer functions are not for anonymous callers. Postgres grants EXECUTE on
-- functions to PUBLIC by default; withdraw it and grant the application role
-- explicitly. (Trigger functions cannot be invoked directly, so the trigger
-- one needs no grant handling.)
revoke execute on function
  crm.mark_overdue_instalments(),
  crm.expire_missed_callbacks(),
  crm.snapshot_scores(date),
  crm.detect_bulk_access(),
  crm.detect_off_hours_access()
from public;

grant execute on function
  crm.mark_overdue_instalments(),
  crm.expire_missed_callbacks(),
  crm.snapshot_scores(date),
  crm.detect_bulk_access(),
  crm.detect_off_hours_access()
to crm_app;
