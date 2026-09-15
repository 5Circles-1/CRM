-- 0069_inbound_call_register.sql
--
-- The owner: "give an option to see the list of all the inbound calls
-- punched in and who punched in, and they can also have an option to set
-- up a reminder to follow up on the inbound calls."
--
-- Inbound calls have had their own source since 0055 and a monthly count on
-- the Floor since 0057 - but the count was the only trace. No screen
-- answered "which clients rang us, who took each call, and is the promise
-- we made them still standing?" This view is that register.
--
-- One row per inbound-call lead, carrying:
--   - who punched it in: the actor on the lead's manual_lead_added event,
--     written by crm.add_manual_lead at creation. That person is not always
--     today's owner (an admin can punch a call in and route it, and a lead
--     can be transferred later), so both are shown side by side.
--   - the promise clock: next_action_at is the follow-up date the client
--     heard on the phone - it is also a pending callback, the kind that
--     rings the bell (0055/0052).
--   - the reminder fields, so the register can offer "remind me about this
--     one" without a second fetch. The reminder is the existing per-lead
--     nudge (reminder_at / reminder_note / reminder_muted, set through
--     PUT /leads/:id/reminder); nothing new is invented for it.
--
-- security_invoker, like every list view: RLS on crm.leads decides whose
-- register this is - a caller sees the inbound calls they own, a counsellor
-- their team's, admin/ops/viewer the whole floor. The lateral join to
-- lead_events inherits lead visibility through crm.can_see_lead, and the
-- names come from crm.users, which any logged-in user may read.

create or replace view crm.v_inbound_calls as
select
  l.id                                   as lead_id,
  l.full_name,
  l.phone_e164,
  l.city,
  l.status,
  l.priority,
  l.team_id,
  t.name                                 as team_name,
  l.caller_id,
  l.counsellor_id,
  coalesce(l.counsellor_id, l.caller_id) as owner_id,
  ow.full_name                           as owner_name,
  l.created_at                           as punched_at,
  ev.actor_id                            as punched_by_id,
  pu.full_name                           as punched_by,
  l.next_action_at,
  l.next_action_note,
  l.last_contacted_at,
  l.attempt_count,
  l.reminder_at,
  l.reminder_note,
  l.reminder_muted,
  crm.lead_green_reason(l.id)            as green_reason
from crm.leads l
left join crm.teams t on t.id = l.team_id
left join lateral (
  select e.actor_id
    from crm.lead_events e
   where e.lead_id = l.id and e.event_type = 'manual_lead_added'
   order by e.occurred_at asc
   limit 1
) ev on true
left join crm.users pu on pu.id = ev.actor_id
left join crm.users ow on ow.id = coalesce(l.counsellor_id, l.caller_id)
where l.source_id = '33333333-0000-0000-0000-000000000004';

alter view crm.v_inbound_calls set (security_invoker = true);
grant select on crm.v_inbound_calls to crm_app;

comment on view crm.v_inbound_calls is
  'The inbound-call register: every client who rang the office, who punched
   the call in and when, who owns it now, and the follow-up promise. RLS on
   crm.leads scopes it (security_invoker), so each role sees exactly the
   inbound calls they may see.';
