-- 0010_audit_and_access.sql
-- Requirement 9, part one: nothing changes without a record, and nobody reads
-- the lead book at scale without it being visible.
--
-- HONEST FRAMING. The realistic threat to a sales CRM is not an outside
-- attacker - it is a departing employee walking out with the lead list. So the
-- objective here is: hard to breach, impossible to breach quietly, quick to
-- reconstruct what happened. These tables serve the middle clause.

create table crm.audit_log (
  id         bigserial primary key,
  table_name text not null,
  row_id     text not null,
  action     text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  actor_id   uuid,
  changed    jsonb,
  before     jsonb,
  occurred_at timestamptz not null default now()
);

create index audit_log_row_idx   on crm.audit_log (table_name, row_id, occurred_at desc);
create index audit_log_actor_idx on crm.audit_log (actor_id, occurred_at desc);

create trigger audit_log_append_only
  before update or delete on crm.audit_log
  for each row execute function crm.tg_append_only();

-- Identify an audited row by its actual primary key. Most tables here key on
-- `id`, but crm.settings keys on `key` and future tables may use composites,
-- so this resolves the real PK rather than assuming a column name.
create or replace function crm.audit_row_key(p_relid oid, p_row jsonb)
  returns text
  language plpgsql stable
as $$
declare
  v_key text;
begin
  v_key := p_row ->> 'id';
  if v_key is not null then
    return v_key;
  end if;

  select string_agg(p_row ->> a.attname, '|' order by k.ord)
    into v_key
    from pg_index i
    join lateral unnest(i.indkey) with ordinality k(attnum, ord) on true
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
   where i.indrelid = p_relid
     and i.indisprimary;

  return coalesce(v_key, '(unkeyed)');
end
$$;

-- Generic audit trigger. Records only the fields that actually changed, so
-- the log stays readable instead of a wall of identical rows.
create or replace function crm.tg_audit() returns trigger
  language plpgsql security definer
  set search_path = crm, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_changed jsonb;
  v_row_id text;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_row_id := crm.audit_row_key(tg_relid, v_old);
    insert into crm.audit_log (table_name, row_id, action, actor_id, before)
    values (tg_table_name, v_row_id, 'DELETE', crm.current_user_id(), v_old);
    return old;
  end if;

  v_new := to_jsonb(new);
  v_row_id := crm.audit_row_key(tg_relid, v_new);

  if tg_op = 'INSERT' then
    insert into crm.audit_log (table_name, row_id, action, actor_id, changed)
    values (tg_table_name, v_row_id, 'INSERT', crm.current_user_id(), v_new);
    return new;
  end if;

  v_old := to_jsonb(old);
  select jsonb_object_agg(key, value) into v_changed
    from jsonb_each(v_new)
   where key not in ('updated_at')
     and value is distinct from (v_old -> key);

  if v_changed is not null then
    insert into crm.audit_log (table_name, row_id, action, actor_id, changed, before)
    values (tg_table_name, v_row_id, 'UPDATE', crm.current_user_id(), v_changed,
            (select jsonb_object_agg(key, v_old -> key) from jsonb_each(v_changed)));
  end if;

  return new;
end
$$;

create trigger leads_audit
  after insert or update or delete on crm.leads
  for each row execute function crm.tg_audit();

create trigger users_audit
  after insert or update or delete on crm.users
  for each row execute function crm.tg_audit();

create trigger deals_audit
  after insert or update or delete on crm.deals
  for each row execute function crm.tg_audit();

create trigger settings_audit
  after insert or update or delete on crm.settings
  for each row execute function crm.tg_audit();

create trigger team_memberships_audit
  after insert or update or delete on crm.team_memberships
  for each row execute function crm.tg_audit();

-- ---------------------------------------------------------------------------
-- Read access log. The application writes one row per lead record opened.
-- This is what makes a quiet bulk scrape impossible.
-- ---------------------------------------------------------------------------

create table crm.lead_access_log (
  id         bigserial primary key,
  user_id    uuid not null references crm.users(id) on delete cascade,
  lead_id    uuid not null,
  -- 'detail' | 'list' | 'export' | 'api'
  context    text not null,
  ip_address inet,
  accessed_at timestamptz not null default now()
);

create index lead_access_log_user_time_idx on crm.lead_access_log (user_id, accessed_at desc);

create table crm.security_alerts (
  id          bigserial primary key,
  alert_type  text not null,
  user_id     uuid references crm.users(id) on delete set null,
  severity    text not null check (severity in ('low', 'medium', 'high')),
  detail      jsonb not null default '{}'::jsonb,
  raised_at   timestamptz not null default now(),
  acknowledged_by uuid references crm.users(id) on delete set null,
  acknowledged_at timestamptz
);

create index security_alerts_open_idx on crm.security_alerts (raised_at desc)
  where acknowledged_at is null;

-- Bulk-read detection. Run every few minutes.
create or replace function crm.detect_bulk_access() returns int
  language plpgsql
as $$
declare
  v_threshold int := crm.setting_int('security.bulk_view_alert_threshold', 300);
  v_count     int;
begin
  with offenders as (
    select a.user_id, count(distinct a.lead_id) as leads_touched
      from crm.lead_access_log a
     where a.accessed_at > now() - interval '1 hour'
     group by a.user_id
    having count(distinct a.lead_id) >= v_threshold
  ),
  fresh as (
    select o.* from offenders o
     where not exists (
       select 1 from crm.security_alerts s
        where s.user_id = o.user_id
          and s.alert_type = 'bulk_lead_access'
          and s.raised_at > now() - interval '1 hour'
     )
  )
  insert into crm.security_alerts (alert_type, user_id, severity, detail)
  select 'bulk_lead_access', f.user_id, 'high',
         jsonb_build_object('leads_touched', f.leads_touched, 'window', '1 hour', 'threshold', v_threshold)
    from fresh f;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

comment on function crm.detect_bulk_access() is
  'Raises an alert when one user opens an abnormal number of distinct lead records in an hour - the signature of a lead-list scrape before resignation.';

-- Off-hours access is the other classic exfiltration signal.
create or replace function crm.detect_off_hours_access() returns int
  language plpgsql
as $$
declare v_count int;
begin
  with offenders as (
    select a.user_id, count(*) as reads, min(a.accessed_at) as first_read
      from crm.lead_access_log a
      join crm.users u on u.id = a.user_id
     where a.accessed_at > now() - interval '1 hour'
       and u.role in ('caller', 'counsellor')
       and (
         (a.accessed_at at time zone 'Asia/Kolkata')::time < time '08:00'
         or (a.accessed_at at time zone 'Asia/Kolkata')::time > time '21:00'
       )
     group by a.user_id
    having count(*) >= 50
  )
  insert into crm.security_alerts (alert_type, user_id, severity, detail)
  select 'off_hours_access', o.user_id, 'medium',
         jsonb_build_object('reads', o.reads, 'first_read', o.first_read)
    from offenders o
   where not exists (
     select 1 from crm.security_alerts s
      where s.user_id = o.user_id and s.alert_type = 'off_hours_access'
        and s.raised_at > now() - interval '6 hours'
   );

  get diagnostics v_count = row_count;
  return v_count;
end
$$;
