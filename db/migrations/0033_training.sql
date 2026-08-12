-- 0033_training.sql
--
-- The Training academy's database half: who has read what, and when.
--
-- The module TEXT deliberately does not live here. It lives in
-- api/content/training/*.md, in git, reviewed like code - so a rule change and
-- the training that explains it land in the same commit. The database stores
-- the thing the database is good at: an acknowledgement, signed and dated,
-- against the exact version of the words the person actually read.
--
-- "Version" is the SHA-256 of the module file. Edit a module and its hash
-- changes, every acknowledgement of it goes stale, and the floor is asked to
-- re-read. Nobody has to remember to bump a number.

create table crm.training_acks (
  user_id     uuid not null references crm.users(id) on delete cascade,
  module_slug text not null,
  -- The content hash of what they read. Not a pointer to "the latest".
  version     text not null,
  quiz_score  int check (quiz_score is null or quiz_score between 0 and 100),
  acked_at    timestamptz not null default now(),
  primary key (user_id, module_slug)
);

create index training_acks_module_idx on crm.training_acks (module_slug, acked_at desc);

alter table crm.training_acks enable row level security;

-- Everyone can see who has been trained: this is a compliance record, not a
-- performance score, and hiding it would only make chasing it harder.
create policy training_acks_read on crm.training_acks
  for select using (crm.current_user_id() is not null);

-- You may only sign your own name.
create policy training_acks_write on crm.training_acks
  for insert with check (user_id = crm.current_user_id());
create policy training_acks_update on crm.training_acks
  for update using (user_id = crm.current_user_id())
  with check (user_id = crm.current_user_id());

grant select, insert, update on crm.training_acks to crm_app;

create trigger training_acks_audit
  after insert or update or delete on crm.training_acks
  for each row execute function crm.tg_audit();

-- The compliance matrix, minus the module list (which the API supplies from
-- the files): one row per person per module they have acknowledged, with the
-- version they signed. The API marks a row stale when that version no longer
-- matches the file on disk.
create or replace view crm.v_training_compliance as
select
  u.id as user_id, u.full_name, u.role, u.is_active,
  a.module_slug, a.version, a.quiz_score, a.acked_at
from crm.users u
left join crm.training_acks a on a.user_id = u.id
where u.is_active;

alter view crm.v_training_compliance set (security_invoker = true);
grant select on crm.v_training_compliance to crm_app;

-- The guided tour is offered once and then only on request. Storing it here
-- rather than in localStorage means a new starter who logs in from a second
-- machine is not walked through it twice.
alter table crm.users
  add column if not exists tour_completed_at timestamptz;

-- Marking your own tour done is the one thing a non-admin may change about
-- their own user row. It gets a function rather than a policy because RLS is
-- row-level: a policy letting someone update their own row would also let
-- them edit their own role. This touches exactly one column.
create or replace function crm.complete_tour() returns timestamptz
  language sql
  security definer
  set search_path = crm, public
as $$
  update crm.users set tour_completed_at = coalesce(tour_completed_at, now())
   where id = crm.current_user_id()
  returning tour_completed_at
$$;

revoke execute on function crm.complete_tour() from public;
grant execute on function crm.complete_tour() to crm_app;
