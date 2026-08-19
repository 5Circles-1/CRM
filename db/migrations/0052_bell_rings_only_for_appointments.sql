-- 0052_bell_rings_only_for_appointments.sql
--
-- The owner, looking at a bell stuck on 99+: "I want them to go to 0, and
-- only actually critical notifications to reach the team. A reminder should
-- come only when the caller or counsellor set it."
--
-- The bell was counting the floor's whole WORK LIST - 163 overdue follow-ups,
-- 18 never-called leads - all of which already live on their own screens (My
-- Pipeline's Overdue bucket, the Fresh leads tab, Re-tap). Counting them
-- twice made the badge a number nobody reads, which is how a real callback
-- hides in plain sight.
--
-- From here the bell counts ONLY:
--   - the callback a client asked for (entered by the caller),
--   - the reminder the lead's owner set for themselves,
--   - a genuine emergency: leads have stopped arriving (admins only).
--
-- Which kinds count is a setting, like the popup list. NOTHING is deleted:
-- the full, RLS-scoped work list is still served (the Alerts tab offers it
-- behind one deliberate click), every engine still writes every alert, and
-- the overdue work keeps its home in the pipeline buckets.

insert into crm.settings (key, value, description) values
  ('alerts.bell_kinds',
   '["callback_due","callback_soon","custom_reminder","intake_stalled"]'::jsonb,
   'Alert kinds the bell counts and lists. Only times a person chose - the '
   || 'client''s callback and the owner''s own reminder - plus the intake '
   || 'emergency. Everything else stays on its work screens.')
on conflict (key) do nothing;

-- One-time tidy: unread notifications older than a day are stale news - the
-- morning brief from last Tuesday and the intake alarms of a solved outage
-- were holding the badge at 99+ forever. Anything newer stays unread.
update crm.notifications
   set read_at = now()
 where read_at is null
   and created_at < now() - interval '24 hours';
