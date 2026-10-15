-- Token View mobile beta. Apply with Supabase CLI `supabase db push`, or as
-- one transaction in the Supabase SQL editor. No provider tokens are stored.
begin;

-- Clients must not create competing REST RPCs or attacker-owned overloads.
revoke create on schema public from public, anon, authenticated, service_role;

create schema if not exists token_view_private;
revoke all on schema token_view_private from public, anon, authenticated, service_role;

-- Helpers are intentionally outside the REST-exposed public schema. Every
-- function has an empty search_path; all application objects are qualified.
create function token_view_private.has_keys(v jsonb, required text[], allowed text[])
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'object' then
    v ?& required and not exists (
      select 1 from jsonb_object_keys(v) as k where not (k = any(allowed))
    ) else false end
$$;

create function token_view_private.is_number(v jsonb, lo numeric, hi numeric, integral boolean default false)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'number' then
    (v #>> '{}')::numeric between lo and hi
    and (not integral or trunc((v #>> '{}')::numeric) = (v #>> '{}')::numeric)
  else false end
$$;

create function token_view_private.is_text(v jsonb, lo integer, hi integer)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(v) = 'string'
    and length(v #>> '{}') between lo and hi
    and (v #>> '{}') !~ '[[:cntrl:]]', false)
$$;

create function token_view_private.valid_settings(v jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(token_view_private.has_keys(v,
      array['currency','krwRate','monthlyBudget','budgetClaude','budgetCodex'],
      array['currency','krwRate','monthlyBudget','budgetClaude','budgetCodex'])
    and v->>'currency' in ('USD','KRW')
    and token_view_private.is_number(v->'krwRate', 0, 1000000)
    and v->'krwRate' <> '0'::jsonb
    and (v->'monthlyBudget' = 'null'::jsonb or token_view_private.is_number(v->'monthlyBudget', 0, 1000000000))
    and (v->'budgetClaude' = 'null'::jsonb or token_view_private.is_number(v->'budgetClaude', 0, 1000000000))
    and (v->'budgetCodex' = 'null'::jsonb or token_view_private.is_number(v->'budgetCodex', 0, 1000000000)), false)
$$;

create function token_view_private.valid_dashboard(v jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  group_name text;
  row_data jsonb;
  field_name text;
  extra_keys text[];
  token_keys constant text[] := array['input','cacheWrite','cacheRead','output','reasoning','cost','requests'];
  all_keys text[];
begin
  if not token_view_private.has_keys(v,
      array['now','totals','daily','dailyModel','dailyProject','hourly','fine','limits','unpriced','sessions'],
      array['now','totals','daily','dailyModel','dailyProject','hourly','fine','limits','unpriced','sessions'])
    or not token_view_private.is_number(v->'now', 0, 9007199254740991, true) then
    return false;
  end if;
  foreach group_name in array array['totals','daily','dailyModel','dailyProject','hourly','fine','limits','unpriced','sessions'] loop
    if jsonb_typeof(v->group_name) is distinct from 'array' then return false; end if;
    -- The byte limit bounds the total data. These bounds preserve 35 days of
    -- hourly/fine buckets for both providers and the desktop's 500 sessions.
    if jsonb_array_length(v->group_name) > (case group_name
      when 'sessions' then 500 when 'totals' then 2 when 'fine' then 10082
      when 'hourly' then 1682 else 100000 end) then return false; end if;
    extra_keys := case group_name
      when 'totals' then array['source','firstTs','lastTs']
      when 'daily' then array['source','date']
      when 'dailyModel' then array['source','date','model']
      when 'dailyProject' then array['source','date','project']
      when 'hourly' then array['source','hour']
      when 'fine' then array['source','t']
      when 'sessions' then array['source','session','project','firstTs','lastTs','models']
      when 'limits' then array['source','limitId','win','ts','usedPct','windowMinutes','resetsAt','plan']
      when 'unpriced' then array['source','model','requests','tokens'] end;
    all_keys := case when group_name in ('limits','unpriced') then extra_keys else token_keys || extra_keys end;
    for row_data in select value from jsonb_array_elements(v->group_name) loop
      if not token_view_private.has_keys(row_data, all_keys, all_keys)
        or not coalesce(row_data->>'source' in ('claude','codex'),false) then return false; end if;
      if group_name not in ('limits','unpriced') then
        foreach field_name in array token_keys loop
          if not token_view_private.is_number(row_data->field_name, 0, 9007199254740991, field_name <> 'cost') then return false; end if;
        end loop;
      end if;
      foreach field_name in array array['firstTs','lastTs','hour','t','ts','resetsAt','windowMinutes','requests','tokens'] loop
        if row_data ? field_name and not token_view_private.is_number(row_data->field_name, 0, 9007199254740991, true) then return false; end if;
      end loop;
      if row_data ? 'firstTs' and (row_data->>'firstTs')::numeric > (row_data->>'lastTs')::numeric then return false; end if;
      if row_data ? 'date' and (not token_view_private.is_text(row_data->'date',10,10) or row_data->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then return false; end if;
      if row_data ? 'date' then
        begin
          perform (row_data->>'date')::date;
        exception when datetime_field_overflow or invalid_datetime_format then return false;
        end;
      end if;
      foreach field_name in array array['model','models','session','project','limitId','win','plan'] loop
        if row_data ? field_name and not token_view_private.is_text(row_data->field_name,0,512) then return false; end if;
      end loop;
      -- Project labels are sanitized labels, never absolute POSIX/Windows paths.
      if row_data ? 'project' and row_data->>'project' ~ '^(/|~|[A-Za-z]:[/\\]|\\\\)' then return false; end if;
      if row_data ? 'usedPct' and not token_view_private.is_number(row_data->'usedPct',0,1000000) then return false; end if;
    end loop;
  end loop;
  return true;
end
$$;

create function token_view_private.valid_pricing(v jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  entry jsonb;
  field_name text;
  entry_keys constant text[] := array['model','input','output','cache_write_5m','cache_write_1h','cache_read','long_ctx_threshold','long_input_mult','long_output_mult'];
begin
  if not token_view_private.has_keys(v,
      array['pricing','custom','defaultVersion','builtinVersion','remoteUrl'],
      array['pricing','custom','defaultVersion','builtinVersion','remoteUrl'])
    or jsonb_typeof(v->'custom') is distinct from 'boolean'
    or not token_view_private.is_text(v->'defaultVersion',0,128)
    or not token_view_private.is_text(v->'builtinVersion',0,128)
    or not coalesce(v->>'remoteUrl' in ('','https://raw.githubusercontent.com/frotrue/token-view/main/pricing.json'),false)
    or not token_view_private.has_keys(v->'pricing', array['version','entries','fast_mult','web_search_usd'], array['version','entries','fast_mult','web_search_usd'])
    or not token_view_private.is_text(v#>'{pricing,version}',0,128)
    or not token_view_private.is_number(v#>'{pricing,fast_mult}',0,1000000000)
    or not token_view_private.is_number(v#>'{pricing,web_search_usd}',0,1000000000)
    or jsonb_typeof(v#>'{pricing,entries}') is distinct from 'array' then return false; end if;
  if jsonb_array_length(v#>'{pricing,entries}') > 10000 then return false; end if;
  for entry in select value from jsonb_array_elements(v#>'{pricing,entries}') loop
    if not token_view_private.has_keys(entry,entry_keys,entry_keys)
      or not token_view_private.is_text(entry->'model',1,512) then return false; end if;
    foreach field_name in array entry_keys[2:9] loop
      if not token_view_private.is_number(entry->field_name,0,9007199254740991,field_name = 'long_ctx_threshold') then return false; end if;
    end loop;
  end loop;
  return true;
end
$$;

create function token_view_private.valid_live_info(v jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  field_name text;
  credit jsonb;
begin
  if not token_view_private.has_keys(v, array[]::text[], array['windows','ts','planType','credits','resetCredits','reached']) then return false; end if;
  foreach field_name in array array['windows','ts','resetCredits'] loop
    if v ? field_name and v->field_name <> 'null'::jsonb
      and not token_view_private.is_number(v->field_name,0,9007199254740991) then return false; end if;
  end loop;
  foreach field_name in array array['planType','reached'] loop
    if v ? field_name and v->field_name <> 'null'::jsonb
      and not token_view_private.is_text(v->field_name,0,128) then return false; end if;
  end loop;
  if v ? 'credits' and v->'credits' <> 'null'::jsonb then
    credit := v->'credits';
    if not token_view_private.has_keys(credit,array['hasCredits','unlimited'],array['hasCredits','unlimited','balance'])
      or jsonb_typeof(credit->'hasCredits') is distinct from 'boolean'
      or jsonb_typeof(credit->'unlimited') is distinct from 'boolean'
      or (credit ? 'balance' and credit->'balance' <> 'null'::jsonb and not token_view_private.is_text(credit->'balance',0,64)) then return false; end if;
  end if;
  return true;
end
$$;

create function token_view_private.valid_live(v jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  provider text;
  result jsonb;
  page jsonb;
begin
  if not token_view_private.has_keys(v,array[]::text[],array['claude','codex','status','codexInfo']) then return false; end if;
  foreach provider in array array['claude','codex'] loop
    if v ? provider and v->provider <> 'null'::jsonb then
      result := v->provider;
      -- Raw errors and unrecognized provider response fields cannot be stored.
      if not token_view_private.has_keys(result,array['ok','ts'],array['ok','ts','info'])
        or jsonb_typeof(result->'ok') is distinct from 'boolean'
        or not token_view_private.is_number(result->'ts',0,9007199254740991,true)
        or (result ? 'info' and not token_view_private.valid_live_info(result->'info')) then return false; end if;
    end if;
  end loop;
  if v ? 'codexInfo' and v->'codexInfo' <> 'null'::jsonb and not token_view_private.valid_live_info(v->'codexInfo') then return false; end if;
  if v ? 'status' and v->'status' <> 'null'::jsonb then
    result := v->'status';
    if not token_view_private.has_keys(result,array['ts','pages'],array['ts','pages'])
      or not token_view_private.is_number(result->'ts',0,9007199254740991,true)
      or jsonb_typeof(result->'pages') is distinct from 'array' then return false; end if;
    if jsonb_array_length(result->'pages') > 2 then return false; end if;
    for page in select value from jsonb_array_elements(result->'pages') loop
      if not token_view_private.has_keys(page,array['id','name','url','indicator','description'],array['id','name','url','indicator','description'])
        or not token_view_private.is_text(page->'id',1,32)
        or not token_view_private.is_text(page->'name',1,128)
        or not token_view_private.is_text(page->'description',0,512)
        or not coalesce(page->>'url' in ('https://status.claude.com','https://status.openai.com'),false)
        or not coalesce(page->>'indicator' in ('none','minor','major','critical','maintenance','unknown'),false) then return false; end if;
    end loop;
  end if;
  return true;
end
$$;

create function token_view_private.valid_snapshot(v jsonb, device_id uuid, device_name text, captured_at timestamptz)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if v is null or octet_length(v::text) > 4194304 then return false; end if;
  if not token_view_private.has_keys(v,
      array['schemaVersion','device','capturedAt','timezone','dashboard','pricing','settings','live','claudeHooked'],
      array['schemaVersion','device','capturedAt','timezone','dashboard','pricing','settings','live','claudeHooked'])
    or v->'schemaVersion' is distinct from '1'::jsonb
    or not token_view_private.has_keys(v->'device',array['id','name'],array['id','name'])
    or v#>>'{device,id}' is distinct from device_id::text
    or v#>>'{device,name}' is distinct from device_name
    or not token_view_private.is_number(v->'capturedAt',0,9007199254740991,true)
    or not token_view_private.is_text(v->'timezone',1,100)
    or jsonb_typeof(v->'claudeHooked') is distinct from 'boolean' then return false; end if;
  if abs((v->>'capturedAt')::numeric - extract(epoch from captured_at) * 1000) >= 1 then return false; end if;
  return coalesce(token_view_private.valid_settings(v->'settings')
    and token_view_private.valid_dashboard(v->'dashboard')
    and token_view_private.valid_pricing(v->'pricing')
    and token_view_private.valid_live(v->'live'), false);
end
$$;

create table public.snapshots (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null check (device_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  device_name text not null check (length(device_name) between 1 and 128 and device_name = btrim(device_name) and device_name !~ '[[:cntrl:]]'),
  captured_at timestamptz not null check (isfinite(captured_at) and captured_at >= '1970-01-01 UTC'),
  uploaded_at timestamptz not null default clock_timestamp() check (isfinite(uploaded_at)),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4194304),
  primary key (user_id, device_id)
);
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null check (token_view_private.valid_settings(settings)),
  updated_at timestamptz not null default clock_timestamp() check (isfinite(updated_at))
);
create table public.refresh_requests (
  user_id uuid not null,
  device_id uuid not null,
  requested_at timestamptz not null default clock_timestamp() check (isfinite(requested_at)),
  handled_at timestamptz check (handled_at is null or (isfinite(handled_at) and handled_at >= requested_at)),
  primary key (user_id, device_id),
  foreign key (user_id, device_id) references public.snapshots(user_id, device_id) on delete cascade
);

alter table public.snapshots enable row level security;
alter table public.user_settings enable row level security;
alter table public.refresh_requests enable row level security;
alter table public.snapshots force row level security;
alter table public.user_settings force row level security;
alter table public.refresh_requests force row level security;
create policy snapshots_owner_read on public.snapshots for select to authenticated using (user_id = (select auth.uid()));
create policy user_settings_owner_read on public.user_settings for select to authenticated using (user_id = (select auth.uid()));
create policy refresh_requests_owner_read on public.refresh_requests for select to authenticated using (user_id = (select auth.uid()));

-- Supabase may grant default table/function privileges. Remove them explicitly.
revoke all on table public.snapshots, public.user_settings, public.refresh_requests from public, anon, authenticated, service_role;
grant select on table public.snapshots, public.user_settings, public.refresh_requests to authenticated;

create function public.publish_snapshot(p_device_id uuid, p_device_name text, p_captured_at timestamptz, p_payload jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  uploaded timestamptz;
  existing public.snapshots%rowtype;
begin
  if owner_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_device_id is null or p_device_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_device_name is null or length(p_device_name) not between 1 and 128
    or p_device_name <> btrim(p_device_name) or p_device_name ~ '[[:cntrl:]]'
    or p_captured_at is null or not isfinite(p_captured_at)
    or p_captured_at < '1970-01-01 UTC' or p_captured_at > clock_timestamp() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'Invalid snapshot metadata';
  end if;
  if not token_view_private.valid_snapshot(p_payload,p_device_id,p_device_name,p_captured_at) then
    raise exception using errcode = '22023', message = 'Invalid snapshot payload (schema, metadata, fields, or 4 MiB limit)';
  end if;
  insert into public.snapshots as current_snapshot (user_id,device_id,device_name,captured_at,uploaded_at,payload)
    values (owner_id,p_device_id,p_device_name,p_captured_at,clock_timestamp(),p_payload)
  on conflict (user_id,device_id) do update set
    device_name = excluded.device_name, captured_at = excluded.captured_at,
    uploaded_at = clock_timestamp(), payload = excluded.payload
  where excluded.captured_at > current_snapshot.captured_at
  returning uploaded_at into uploaded;
  if uploaded is not null then return uploaded; end if;
  select * into existing from public.snapshots where user_id = owner_id and device_id = p_device_id;
  -- A network retry of precisely the same capture is idempotent. It cannot
  -- move either capture time or upload time forward, or change that payload.
  if existing.captured_at = p_captured_at and existing.device_name = p_device_name and existing.payload = p_payload then
    return existing.uploaded_at;
  end if;
  raise exception using errcode = '22023', message = 'Snapshot is stale or conflicts with an existing capture';
end
$$;

create function public.save_user_settings(p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  saved public.user_settings%rowtype;
begin
  if owner_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_settings is null or octet_length(p_settings::text) > 1024 or not coalesce(token_view_private.valid_settings(p_settings),false) then
    raise exception using errcode = '22023', message = 'Invalid shared settings';
  end if;
  insert into public.user_settings as current_settings (user_id,settings,updated_at)
    values (owner_id,p_settings,clock_timestamp())
  on conflict (user_id) do update set settings = excluded.settings,
    updated_at = case when current_settings.settings = excluded.settings then current_settings.updated_at else clock_timestamp() end
  returning * into saved;
  return to_jsonb(saved);
end
$$;

create function public.request_refresh(p_device_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  server_now timestamptz := clock_timestamp();
  requested public.refresh_requests%rowtype;
begin
  if owner_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_device_id is null or not exists (select 1 from public.snapshots where user_id = owner_id and device_id = p_device_id) then
    raise exception using errcode = '22023', message = 'Unknown device';
  end if;
  insert into public.refresh_requests as current_request (user_id,device_id,requested_at,handled_at)
    values (owner_id,p_device_id,server_now,null)
  on conflict (user_id,device_id) do update set
    requested_at = case when
      (current_request.handled_at is null and current_request.requested_at > server_now - interval '10 minutes')
      or current_request.requested_at > server_now - interval '60 seconds'
      then current_request.requested_at else server_now end,
    handled_at = case when
      (current_request.handled_at is null and current_request.requested_at > server_now - interval '10 minutes')
      or current_request.requested_at > server_now - interval '60 seconds'
      then current_request.handled_at else null end
  returning * into requested;
  return to_jsonb(requested);
end
$$;

create function public.acknowledge_refresh(p_device_id uuid, p_requested_at timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  affected integer;
begin
  if owner_id is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_device_id is null or p_requested_at is null or not isfinite(p_requested_at) then
    raise exception using errcode = '22023', message = 'Invalid refresh acknowledgement';
  end if;
  update public.refresh_requests as requested set handled_at = clock_timestamp()
    where requested.user_id = owner_id and requested.device_id = p_device_id
      and requested.requested_at = p_requested_at and requested.handled_at is null
      and requested.requested_at > clock_timestamp() - interval '10 minutes'
      and exists (select 1 from public.snapshots as snapshot
        where snapshot.user_id = owner_id and snapshot.device_id = p_device_id
          and snapshot.uploaded_at >= requested.requested_at);
  get diagnostics affected = row_count;
  return affected = 1;
end
$$;

revoke all on all functions in schema token_view_private from public, anon, authenticated, service_role;
revoke all on function public.publish_snapshot(uuid,text,timestamptz,jsonb), public.save_user_settings(jsonb),
  public.request_refresh(uuid), public.acknowledge_refresh(uuid,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.publish_snapshot(uuid,text,timestamptz,jsonb), public.save_user_settings(jsonb),
  public.request_refresh(uuid), public.acknowledge_refresh(uuid,timestamptz) to authenticated;

comment on table public.snapshots is 'Owner-private latest validated desktop snapshot per device. RPC writes only.';
comment on table public.user_settings is 'Owner-private allowlisted display/budget settings. RPC writes only.';
comment on table public.refresh_requests is 'Owner-private, coalesced PC refresh requests; no arbitrary commands. Expires after 10 minutes.';
comment on function public.request_refresh(uuid) is 'Server timestamp only. Coalesces unhandled requests and enforces at least 60 seconds between requests.';
comment on function public.acknowledge_refresh(uuid,timestamptz) is 'Acknowledges the exact nonexpired request only after a successful later publication.';

commit;
