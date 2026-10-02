-- 0083: outside cloud calling by choice (owner request, 2 Oct).
--
-- Part of the floor calls from office or personal phones and holds no
-- Smartflo line - deliberately, the owner's call. The coverage panel still
-- listed each of them as a problem ("no Dialing number", "number is not a
-- Smartflo agent"), forever, with no way to answer it. An alarm that can
-- never be cleared teaches the admin to ignore the panel - which is how a
-- real gap slips past one day. The choice needed a place to live.
--
-- users.cloud_calling, default true. Switched off:
--   - the person leaves crm.v_tata_tele_coverage: they are a decision, not
--     a gap, and the health counts follow the view, so the banner and the
--     watchdog stop counting them too;
--   - /me reads it, so their Call button and Power dial disappear (the UI
--     already keys every dial affordance on me.cloud_calling);
--   - POST /leads/:id/call refuses them with a 409 that says why, so the
--     rule holds even against a stale tab;
--   - working leads and logging calls by hand are untouched - their dials
--     simply stay unverified, which is true.

alter table crm.users add column cloud_calling boolean not null default true;

comment on column crm.users.cloud_calling is
  'Off means this person deliberately calls from an office or personal phone, outside Smartflo: no Call button or Power dial, click-to-call refuses them, and the Tata Tele coverage panel never lists them as a gap. Logging calls by hand is untouched.';

-- The coverage view names only gaps, never choices.
create or replace view crm.v_tata_tele_coverage as
select u.id as user_id,
       u.full_name,
       u.role,
       u.dialing_msisdn,
       case when u.dialing_msisdn is null then 'no_number' else 'not_an_agent' end as problem
  from crm.users u
 where u.is_active
   and u.cloud_calling
   and u.role in ('caller', 'counsellor')
   and (u.dialing_msisdn is null
        or (exists (select 1 from crm.tata_tele_agents)
            and not exists (select 1 from crm.tata_tele_agents ta
                             where ta.agent_msisdn = u.dialing_msisdn)));

comment on view crm.v_tata_tele_coverage is
  'Active callers and counsellors Smartflo cannot serve but should: no Dialing number (click-to-call has no phone to ring), or a number that is no Smartflo agent''s follow-me number (their clicks are refused and their calls never verify). A person with cloud_calling off is a choice, not a gap, and is never listed.';
