-- 0016_floor_feedback.sql
--
-- Five call outcomes the floor kept having to record as something else.
--
-- THIS FILE DOES NOTHING BUT ADD ENUM VALUES, and that is deliberate. Postgres
-- allows a new enum label to be added inside a transaction but not USED in the
-- same one, and migrate.sh runs each file with --single-transaction. Everything
-- that reads these labels is therefore in 0017, which runs after this commits.
--
-- Meanings, since several are not obvious from the label:
--   incoming_unavailable      the number could not be reached at all
--   disconnected_after_intro  they answered and hung up during the opening
--   will_visit                they intend to come to the office - a walk-in
--   job_enquiry               not a client: someone asking about employment
--   will_call_back_self       they will call us, so we should not chase hourly

alter type crm.disposition add value if not exists 'incoming_unavailable';
alter type crm.disposition add value if not exists 'disconnected_after_intro';
alter type crm.disposition add value if not exists 'will_visit';
alter type crm.disposition add value if not exists 'job_enquiry';
alter type crm.disposition add value if not exists 'will_call_back_self';
