-- 0002_users_auth.sql
-- Users, credentials, API sessions.
--
-- The floor is two to four people; there are no teams. Fresh leads rotate
-- between the active callers (rotation_order breaks ties), qualified leads go
-- to the follow-up person.

create table crm.users (
  id              uuid primary key default gen_random_uuid(),
  full_name       text        not null check (length(trim(full_name)) > 0),
  email           citext      not null unique,
  role            crm.user_role not null,
  -- Order in the round-robin when two callers are level on today's count.
  rotation_order  int         not null default 100,
  -- The account background jobs run as. Hidden from pickers and boards;
  -- it cannot log in because it has no credentials row.
  is_service      boolean     not null default false,
  is_active       boolean     not null default true,
  deactivated_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint users_deactivation_consistent
    check ((is_active and deactivated_at is null) or (not is_active and deactivated_at is not null))
);

create index users_role_active_idx on crm.users (role) where is_active;

create trigger users_set_updated_at
  before update on crm.users
  for each row execute function crm.tg_set_updated_at();

alter table crm.settings
  add constraint settings_updated_by_fkey
  foreign key (updated_by) references crm.users(id);

-- Role lookup for RLS policies. SECURITY DEFINER so policies can read
-- crm.users without recursing through that table's own RLS.
create or replace function crm.current_user_role() returns crm.user_role
  language sql stable security definer
  set search_path = crm, pg_temp
as $$
  select u.role from crm.users u where u.id = crm.current_user_id() and u.is_active
$$;

create or replace function crm.is_admin() returns boolean
  language sql stable
as $$ select coalesce(crm.current_user_role() = 'admin', false) $$;

-- Any signed-in, active account. The whole pipeline is visible to the whole
-- floor by design (the "Google Sheet transparency" rule), so this is the read
-- predicate on almost everything.
create or replace function crm.is_active_user() returns boolean
  language sql stable security definer
  set search_path = crm, pg_temp
as $$
  select exists (
    select 1 from crm.users u
     where u.id = crm.current_user_id() and u.is_active
  )
$$;

-- ---------------------------------------------------------------------------
-- Credentials and API sessions.
--
-- Authentication happens *before* app.user_id can be set, so it cannot go
-- through RLS. Every pre-authentication step is a narrow SECURITY DEFINER
-- function with a fixed search_path; crm_app can call them but cannot select
-- from the tables behind them. A SQL injection in a route handler therefore
-- cannot dump password hashes or steal live session tokens.
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('auth.max_failed_attempts', '5'::jsonb,
   'Failed logins before the account locks.'),
  ('auth.lockout_minutes', '15'::jsonb,
   'How long an account stays locked after too many failed logins.'),
  ('auth.session_ttl_hours', '12'::jsonb,
   'Session lifetime. A forgotten login on a shared machine expires the same day.');

create table crm.user_credentials (
  user_id        uuid primary key references crm.users(id) on delete cascade,
  password_hash  text not null,
  must_change    boolean not null default true,
  failed_attempts int not null default 0 check (failed_attempts >= 0),
  locked_until   timestamptz,
  last_login_at  timestamptz,
  updated_at     timestamptz not null default now()
);

create table crm.api_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references crm.users(id) on delete cascade,
  -- Only the hash is stored. A stolen database gives no usable session tokens.
  token_hash  text not null unique,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  ip_address  inet,
  user_agent  text
);

create index api_sessions_user_idx on crm.api_sessions (user_id, issued_at desc);
create index api_sessions_live_idx on crm.api_sessions (expires_at)
  where revoked_at is null;

-- Credentials and sessions are never readable by the application role at all.
alter table crm.user_credentials enable row level security;
alter table crm.api_sessions     enable row level security;
revoke all on crm.user_credentials from crm_app;
revoke all on crm.api_sessions     from crm_app;

create type crm.auth_result as (
  user_id       uuid,
  role          crm.user_role,
  full_name     text,
  password_hash text,
  is_locked     boolean,
  must_change   boolean
);

create or replace function crm.auth_lookup(p_email citext)
  returns crm.auth_result
  language sql stable security definer
  set search_path = crm, pg_temp
as $$
  select u.id, u.role, u.full_name, c.password_hash,
         coalesce(c.locked_until > now(), false),
         coalesce(c.must_change, true)
    from crm.users u
    join crm.user_credentials c on c.user_id = u.id
   where u.email = p_email and u.is_active
$$;

comment on function crm.auth_lookup(citext) is
  'Returns the credential record for a login attempt. The caller must still verify the password hash - this function deliberately does no comparison, so timing behaviour stays in the application where a constant-time check lives.';

create or replace function crm.auth_record_attempt(p_user_id uuid, p_success boolean)
  returns void
  language plpgsql security definer
  set search_path = crm, pg_temp
as $$
declare
  v_max  int := crm.setting_int('auth.max_failed_attempts', 5);
  v_lock int := crm.setting_int('auth.lockout_minutes', 15);
begin
  if p_success then
    update crm.user_credentials
       set failed_attempts = 0, locked_until = null, last_login_at = now()
     where user_id = p_user_id;
  else
    update crm.user_credentials
       set failed_attempts = failed_attempts + 1,
           locked_until = case
             when failed_attempts + 1 >= v_max then now() + make_interval(mins => v_lock)
             else locked_until
           end
     where user_id = p_user_id;
  end if;
end
$$;

create or replace function crm.session_create(
    p_user_id uuid, p_token_hash text, p_ip inet, p_user_agent text)
  returns timestamptz
  language plpgsql security definer
  set search_path = crm, pg_temp
as $$
declare
  v_expires timestamptz := now() + make_interval(hours => crm.setting_int('auth.session_ttl_hours', 12));
begin
  insert into crm.api_sessions (user_id, token_hash, expires_at, ip_address, user_agent)
  values (p_user_id, p_token_hash, v_expires, p_ip, p_user_agent);
  return v_expires;
end
$$;

create or replace function crm.session_resolve(p_token_hash text)
  returns uuid
  language sql stable security definer
  set search_path = crm, pg_temp
as $$
  select s.user_id
    from crm.api_sessions s
    join crm.users u on u.id = s.user_id
   where s.token_hash = p_token_hash
     and s.revoked_at is null
     and s.expires_at > now()
     and u.is_active
$$;

create or replace function crm.session_revoke(p_token_hash text)
  returns void
  language sql security definer
  set search_path = crm, pg_temp
as $$
  update crm.api_sessions set revoked_at = now()
   where token_hash = p_token_hash and revoked_at is null
$$;

-- Deactivating a user must kill their live sessions immediately, not at expiry.
create or replace function crm.tg_revoke_sessions_on_deactivate() returns trigger
  language plpgsql security definer
  set search_path = crm, pg_temp
as $$
begin
  if old.is_active and not new.is_active then
    update crm.api_sessions set revoked_at = now()
     where user_id = new.id and revoked_at is null;
  end if;
  return new;
end
$$;

create trigger users_revoke_sessions_on_deactivate
  after update of is_active on crm.users
  for each row execute function crm.tg_revoke_sessions_on_deactivate();

create or replace function crm.set_password(p_user_id uuid, p_hash text, p_must_change boolean default false)
  returns void
  language sql security definer
  set search_path = crm, pg_temp
as $$
  insert into crm.user_credentials (user_id, password_hash, must_change)
  values (p_user_id, p_hash, p_must_change)
  on conflict (user_id) do update
    set password_hash = excluded.password_hash,
        must_change   = excluded.must_change,
        failed_attempts = 0,
        locked_until  = null,
        updated_at    = now()
$$;

create or replace function crm.purge_expired_sessions() returns int
  language plpgsql security definer
  set search_path = crm, pg_temp
as $$
declare v_count int;
begin
  delete from crm.api_sessions
   where expires_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

grant execute on function
  crm.auth_lookup(citext),
  crm.auth_record_attempt(uuid, boolean),
  crm.session_create(uuid, text, inet, text),
  crm.session_resolve(text),
  crm.session_revoke(text),
  crm.set_password(uuid, text, boolean),
  crm.purge_expired_sessions()
to crm_app;
