-- Run as the database administrator with psql. All fixtures roll back.
-- Works against the local shim or a LOCAL Supabase database, never production.
\set ON_ERROR_STOP on
begin;
create function pg_temp.assert(ok boolean, message text) returns void
language plpgsql set search_path = '' as $$
begin
  if not coalesce(ok,false) then raise exception 'FAIL: %', message; end if;
  raise notice 'PASS: %', message;
end
$$;
create function pg_temp.reject(statement text, expected_state text, message text) returns void
language plpgsql set search_path = '' as $$
declare actual_state text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate;
  end;
  perform pg_temp.assert(actual_state = expected_state, message || ' (SQLSTATE ' || coalesce(actual_state,'none') || ')');
end
$$;
create function pg_temp.payload(device uuid, captured timestamptz, device_name text default 'Test PC') returns jsonb
language sql set search_path = '' as $$
  select jsonb_build_object(
    'schemaVersion',1,'device',jsonb_build_object('id',device::text,'name',device_name),
    'capturedAt',trunc(extract(epoch from captured)*1000),'timezone','UTC',
    'dashboard',jsonb_build_object('now',trunc(extract(epoch from captured)*1000),'totals','[]'::jsonb,'daily','[]'::jsonb,
      'dailyModel','[]'::jsonb,'dailyProject','[]'::jsonb,'hourly','[]'::jsonb,'fine','[]'::jsonb,
      'limits','[]'::jsonb,'unpriced','[]'::jsonb,'sessions','[]'::jsonb),
    'pricing',jsonb_build_object('pricing',jsonb_build_object('version','test','entries','[]'::jsonb,'fast_mult',1,'web_search_usd',0),
      'custom',false,'defaultVersion','test','builtinVersion','test','remoteUrl',''),
    'settings',jsonb_build_object('currency','USD','krwRate',1400,'monthlyBudget',null,'budgetClaude',null,'budgetCodex',0),
    'live','{}'::jsonb,'claudeHooked',false)
$$;
create function pg_temp.publish(captured timestamptz, changes jsonb default '{}'::jsonb) returns timestamptz
language sql set search_path = '' as $$
  select public.publish_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Test PC',captured,
    pg_temp.payload('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',captured) || changes)
$$;
create function pg_temp.token_row() returns jsonb language sql set search_path = '' as $$
  select '{"source":"claude","input":1,"cacheWrite":2,"cacheRead":3,"output":4,"reasoning":5,"cost":0.001,"requests":1}'::jsonb
$$;
create temp table test_state (key text primary key, value text);
grant all on table test_state to authenticated;
insert into test_state values ('capture',(date_trunc('milliseconds',clock_timestamp()) - interval '2 minutes')::text);
insert into auth.users(id,email) values
  ('11111111-1111-1111-1111-111111111111','cloud-test-a@example.invalid'),
  ('22222222-2222-2222-2222-222222222222','cloud-test-b@example.invalid');

select pg_temp.assert((select count(*) = 3 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('snapshots','user_settings','refresh_requests') and c.relrowsecurity and c.relforcerowsecurity), 'all private tables enforce RLS');
select pg_temp.assert((select count(*) = 4 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('publish_snapshot','save_user_settings','request_refresh','acknowledge_refresh')
    and p.prosecdef and 'search_path=""' = any(p.proconfig)), 'all RPCs use security definer and an empty search_path');
select pg_temp.assert(not has_schema_privilege('authenticated','token_view_private','USAGE'), 'private validators are not available to clients');
select pg_temp.assert(not has_schema_privilege('authenticated','public','CREATE'), 'clients cannot create competing public RPCs');
select pg_temp.assert(not has_function_privilege('anon','public.publish_snapshot(uuid,text,timestamptz,jsonb)','EXECUTE')
  and not has_function_privilege('service_role','public.publish_snapshot(uuid,text,timestamptz,jsonb)','EXECUTE'), 'anon and service_role cannot execute publish RPC');

set local role anon;
select pg_temp.reject('select * from public.snapshots','42501','anon cannot read snapshots');
select pg_temp.reject('select * from public.user_settings','42501','anon cannot read settings');
select pg_temp.reject('select * from public.refresh_requests','42501','anon cannot read refresh requests');
select pg_temp.reject('select public.publish_snapshot(null,null,null,null)','42501','anon cannot publish');
select pg_temp.reject('select public.save_user_settings(null)','42501','anon cannot save settings');
select pg_temp.reject('select public.request_refresh(null)','42501','anon cannot request refresh');
select pg_temp.reject('select public.acknowledge_refresh(null,null)','42501','anon cannot acknowledge refresh');
reset role;
set local role service_role;
select pg_temp.reject('select * from public.snapshots','42501','service_role has no table read grant');
select pg_temp.reject('select public.save_user_settings(null)','42501','service_role has no RPC grant');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.assert((select count(*)=0 from public.snapshots),'no identity cannot read snapshots');
select pg_temp.reject('select public.publish_snapshot(null,null,null,null)','42501','authenticated role without identity cannot publish');
select pg_temp.reject('select public.save_user_settings(null)','42501','authenticated role without identity cannot save settings');
select pg_temp.reject('select public.request_refresh(null)','42501','authenticated role without identity cannot request refresh');
select pg_temp.reject('select public.acknowledge_refresh(null,null)','42501','authenticated role without identity cannot acknowledge refresh');

select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
insert into test_state values ('uploaded',pg_temp.publish((select value::timestamptz from test_state where key='capture'))::text);
select pg_temp.assert((select count(*)=1 from public.snapshots),'first authenticated publication succeeds');
select pg_temp.assert((select user_id='11111111-1111-1111-1111-111111111111'::uuid from public.snapshots),'publisher owner comes from authenticated identity');
select pg_temp.assert(public.save_user_settings('{"currency":"KRW","krwRate":1400,"monthlyBudget":null,"budgetClaude":0,"budgetCodex":1000000000}') ->>'user_id'
  = '11111111-1111-1111-1111-111111111111','settings RPC returns an owner-derived JSON row');

select pg_temp.reject($q$insert into public.snapshots select * from public.snapshots$q$,'42501','direct snapshot insert denied');
select pg_temp.reject($q$update public.snapshots set device_name='Forged'$q$,'42501','direct snapshot update denied');
select pg_temp.reject($q$delete from public.snapshots$q$,'42501','direct snapshot delete denied');
select pg_temp.reject($q$truncate public.snapshots cascade$q$,'42501','direct snapshot truncate denied');
select pg_temp.reject($q$insert into public.user_settings values ('22222222-2222-2222-2222-222222222222','{}',now())$q$,'42501','forged settings owner insert denied');
select pg_temp.reject($q$update public.user_settings set user_id='22222222-2222-2222-2222-222222222222'$q$,'42501','forged settings owner update denied');
select pg_temp.reject($q$delete from public.user_settings$q$,'42501','direct settings delete denied');
select pg_temp.reject($q$insert into public.refresh_requests values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',now(),null)$q$,'42501','direct refresh insert denied');
select pg_temp.reject($q$update public.refresh_requests set handled_at=now()$q$,'42501','direct refresh update denied');
select pg_temp.reject($q$delete from public.refresh_requests$q$,'42501','direct refresh delete denied');

select pg_temp.assert(pg_temp.publish((select value::timestamptz from test_state where key='capture'))::text
  = (select value from test_state where key='uploaded'),'identical retry preserves original upload timestamp');
select pg_temp.reject($q$select pg_temp.publish((select value::timestamptz-interval '1 second' from test_state where key='capture'))$q$,'22023','stale capture rejected');
select pg_temp.reject($q$select pg_temp.publish((select value::timestamptz from test_state where key='capture'),'{"claudeHooked":true}')$q$,'22023','different payload at the same capture timestamp rejected');
select pg_temp.assert((select captured_at::text=(select value from test_state where key='capture') from public.snapshots),'stale and conflicting writes leave latest capture untouched');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '6 minutes')$q$,'22023','far-future capture rejected');
select pg_temp.reject($q$select pg_temp.publish('infinity')$q$,'22023','infinite capture timestamp rejected');
select pg_temp.reject($q$select pg_temp.publish(null)$q$,'22023','null capture timestamp rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"capturedAt":1}')$q$,'22023','payload capture timestamp must match RPC timestamp');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"device":{"id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","name":"Test PC"}}')$q$,'22023','forged device ID rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"device":{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","name":"Different PC"}}')$q$,'22023','mismatched device name rejected');
select pg_temp.reject($q$select public.publish_snapshot('00000000-0000-0000-0000-000000000000','Test PC',now(),'{}')$q$,'22023','nil device ID rejected');
select pg_temp.reject($q$select public.publish_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',' Test PC ',now(),'{}')$q$,'22023','untrimmed device name rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"schemaVersion":2}')$q$,'22023','unknown schema version rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"schemaVersion":"1"}')$q$,'22023','string schema version rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"user_id":"22222222-2222-2222-2222-222222222222"}')$q$,'22023','forged owner field rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"providerToken":"test-secret"}')$q$,'22023','unrecognized credential field rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"dashboard":{}}')$q$,'22023','incomplete dashboard rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"live":{"claude":{"ok":false,"ts":1,"error":"raw local error"}}}')$q$,'22023','raw provider error rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),'{"live":{"codex":{"ok":true,"ts":1,"info":{"accessToken":"test-secret"}}}}')$q$,'22023','nested provider credential field rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp(),jsonb_build_object('timezone',repeat('x',4194305)))$q$,'22023','payload exceeding 4 MiB rejected');
select pg_temp.reject($q$select public.publish_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Test PC',now(),'[]')$q$,'22023','nonobject payload rejected');

select pg_temp.reject($q$select public.save_user_settings('{"currency":"USD","krwRate":1400,"monthlyBudget":null,"budgetClaude":null,"budgetCodex":null,"claudeApi":true}')$q$,'22023','desktop preferences cannot be shared');
select pg_temp.reject($q$select public.save_user_settings('{"currency":"EUR","krwRate":1400,"monthlyBudget":null,"budgetClaude":null,"budgetCodex":null}')$q$,'22023','unsupported currency rejected');
select pg_temp.reject($q$select public.save_user_settings('{"currency":null,"krwRate":1400,"monthlyBudget":null,"budgetClaude":null,"budgetCodex":null}')$q$,'22023','null currency rejected');
select pg_temp.reject($q$select public.save_user_settings('{"currency":"USD","krwRate":0,"monthlyBudget":null,"budgetClaude":null,"budgetCodex":null}')$q$,'22023','zero exchange rate rejected');
select pg_temp.reject($q$select public.save_user_settings('{"currency":"USD","krwRate":"1400","monthlyBudget":null,"budgetClaude":null,"budgetCodex":null}')$q$,'22023','string exchange rate rejected');
select pg_temp.reject($q$select public.save_user_settings('{"currency":"USD","krwRate":1000001,"monthlyBudget":null,"budgetClaude":null,"budgetCodex":null}')$q$,'22023','out-of-range exchange rate rejected');
select pg_temp.reject($q$select public.save_user_settings('{"currency":"USD","krwRate":1400,"monthlyBudget":-1,"budgetClaude":null,"budgetCodex":null}')$q$,'22023','negative budget rejected');
select pg_temp.reject($q$select public.save_user_settings('{"currency":"USD","krwRate":1400,"monthlyBudget":null,"budgetClaude":1000000001,"budgetCodex":null}')$q$,'22023','out-of-range budget rejected');
select pg_temp.reject($q$select public.save_user_settings('{"currency":"USD","krwRate":1400}')$q$,'22023','incomplete settings rejected');
select pg_temp.reject($q$select public.save_user_settings('[]')$q$,'22023','nonobject settings rejected');
select pg_temp.assert(public.save_user_settings('{"currency":"USD","krwRate":0.000000001,"monthlyBudget":0,"budgetClaude":null,"budgetCodex":null}')#>>'{settings,krwRate}'='0.000000001','positive fractional exchange rate allowed');

insert into test_state values ('request',public.request_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->>'requested_at');
select pg_temp.assert(public.request_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->>'requested_at'
  = (select value from test_state where key='request'),'repeated pending requests coalesce to the same server timestamp');
select pg_temp.assert(not public.acknowledge_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',(select value::timestamptz from test_state where key='request')),'request cannot be acknowledged before a later successful publication');

select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',true);
select pg_temp.assert((select count(*)=0 from public.snapshots),'second user cannot read first user snapshots');
select pg_temp.assert((select count(*)=0 from public.user_settings),'second user cannot read first user settings');
select pg_temp.assert((select count(*)=0 from public.refresh_requests),'second user cannot read first user refresh requests');
select pg_temp.reject($q$select public.request_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$q$,'22023','second user cannot request first user device');
select pg_temp.assert(not public.acknowledge_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',(select value::timestamptz from test_state where key='request')),'second user cannot acknowledge first user request');
select public.publish_snapshot('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Test PC',clock_timestamp(),pg_temp.payload('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',clock_timestamp()));
select public.save_user_settings('{"currency":"KRW","krwRate":1500,"monthlyBudget":50,"budgetClaude":null,"budgetCodex":null}');
select pg_temp.assert((select count(*)=1 and bool_and(user_id='22222222-2222-2222-2222-222222222222'::uuid) from public.snapshots),'second user sees only own snapshot');
-- Device IDs are scoped by user: copying a device UUID never copies ownership.
select pg_temp.publish(clock_timestamp());
select pg_temp.assert((select count(*)=2 and bool_and(user_id='22222222-2222-2222-2222-222222222222'::uuid) from public.snapshots),'copied device UUID creates an isolated second-user row');
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
select pg_temp.assert((select count(*)=1 and bool_and(device_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid) from public.snapshots),'first user still sees only own device');
select pg_temp.assert((select count(*)=1 and bool_and(settings->>'currency'='USD') from public.user_settings),'second-user setting write cannot change first-user settings');
select pg_temp.reject($q$select public.request_refresh('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$q$,'22023','first user cannot request second-user device');

select pg_temp.publish(date_trunc('milliseconds',clock_timestamp())+interval '1 second');
select pg_temp.assert(public.acknowledge_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',(select value::timestamptz from test_state where key='request')),'successful later publication permits exact acknowledgement');
select pg_temp.assert(not public.acknowledge_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',(select value::timestamptz from test_state where key='request')),'acknowledgement is idempotent and reports no second update');
select pg_temp.assert(public.request_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->'handled_at' <> 'null'::jsonb,'60-second cooldown prevents repeated handled requests');
reset role;
-- Advance the fixture's request age without sleeping or weakening the RPC.
update public.refresh_requests set requested_at=clock_timestamp()-interval '11 minutes',handled_at=null
  where user_id='11111111-1111-1111-1111-111111111111';
insert into test_state values ('expired',(select requested_at::text from public.refresh_requests where user_id='11111111-1111-1111-1111-111111111111'));
set local role authenticated;
select pg_temp.assert(not public.acknowledge_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',(select value::timestamptz from test_state where key='expired')),'expired request cannot be acknowledged');
insert into test_state values ('new_request',public.request_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')->>'requested_at');
select pg_temp.assert((select value::timestamptz from test_state where key='new_request') > (select value::timestamptz from test_state where key='expired'),'expired request is replaced with a new server timestamp');
select pg_temp.publish(date_trunc('milliseconds',clock_timestamp())+interval '2 seconds');
select pg_temp.assert(not public.acknowledge_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',(select value::timestamptz from test_state where key='request')),'late acknowledgement of the old request cannot erase a newer request');
select pg_temp.assert((select handled_at is null and requested_at=(select value::timestamptz from test_state where key='new_request') from public.refresh_requests),'new request remains pending after old acknowledgement race');
select pg_temp.assert(public.acknowledge_refresh('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',(select value::timestamptz from test_state where key='new_request')),'only exact new request can be acknowledged');

-- Null enum fields and unexpected nested keys must never pass JSON validation.
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '3 seconds', jsonb_build_object('live',jsonb_build_object('status',jsonb_build_object('ts',1,'pages',jsonb_build_array(jsonb_build_object('id','claude','name','Claude','url',null,'indicator','none','description','OK'))))))$q$,'22023','null public status URL rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '3 seconds',jsonb_build_object('pricing',jsonb_set(pg_temp.payload('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',clock_timestamp())->'pricing','{remoteUrl}','null')))$q$,'22023','null pricing URL rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '3 seconds',jsonb_build_object('settings','{"currency":"USD","krwRate":1400,"monthlyBudget":-1,"budgetClaude":null,"budgetCodex":null}'::jsonb))$q$,'22023','snapshot shared settings are validated too');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '3 seconds',jsonb_build_object('dashboard',jsonb_set(pg_temp.payload('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',clock_timestamp())->'dashboard','{daily}',jsonb_build_array(pg_temp.token_row() || '{"date":"2026-02-30"}'))))$q$,'22023','invalid calendar date rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '3 seconds',jsonb_build_object('dashboard',jsonb_set(pg_temp.payload('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',clock_timestamp())->'dashboard','{daily}',jsonb_build_array(pg_temp.token_row() || '{"date":"2026-01-01","source":null}'))))$q$,'22023','null dashboard provider rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '3 seconds',jsonb_build_object('dashboard',jsonb_set(pg_temp.payload('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',clock_timestamp())->'dashboard','{dailyProject}',jsonb_build_array(pg_temp.token_row() || '{"date":"2026-01-01","project":"/home/user/private-project"}'))))$q$,'22023','absolute POSIX project path rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '3 seconds',jsonb_build_object('dashboard',jsonb_set(pg_temp.payload('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',clock_timestamp())->'dashboard','{dailyProject}',jsonb_build_array(pg_temp.token_row() || '{"date":"2026-01-01","project":"C:\\Users\\user\\private-project"}'))))$q$,'22023','absolute Windows project path rejected');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '3 seconds',jsonb_build_object('dashboard',jsonb_set(pg_temp.payload('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',clock_timestamp())->'dashboard','{daily}',jsonb_build_array(pg_temp.token_row() || '{"date":"2026-01-01","rawLog":"private"}'))))$q$,'22023','raw source data cannot be hidden in dashboard rows');
select pg_temp.reject($q$select pg_temp.publish(clock_timestamp()+interval '3 seconds',jsonb_build_object('dashboard',jsonb_set(pg_temp.payload('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',clock_timestamp())->'dashboard','{sessions}',(select jsonb_agg(pg_temp.token_row() || '{"session":"hash","project":"label","firstTs":1,"lastTs":2,"models":"test"}') from generate_series(1,501)))))$q$,'22023','more than 500 sessions rejected');

insert into test_state values ('dense_capture',(date_trunc('milliseconds',clock_timestamp())+interval '4 seconds')::text);
select public.publish_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Test PC',
  (select value::timestamptz from test_state where key='dense_capture'),
  jsonb_set(jsonb_set(jsonb_set(pg_temp.payload('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    (select value::timestamptz from test_state where key='dense_capture')),
    '{dashboard,fine}',(select jsonb_agg(pg_temp.token_row() || jsonb_build_object('t',i::bigint*600000)) from generate_series(1,10082) as i)),
    '{dashboard,hourly}',(select jsonb_agg(pg_temp.token_row() || jsonb_build_object('hour',i::bigint*3600000)) from generate_series(1,1682) as i)),
    '{dashboard,sessions}',(select jsonb_agg(pg_temp.token_row() || jsonb_build_object('session','pseudonym-'||i,'project','label','firstTs',1,'lastTs',2,'models','test')) from generate_series(1,500) as i)));
select pg_temp.assert((select jsonb_array_length(payload#>'{dashboard,fine}')=10082
  and jsonb_array_length(payload#>'{dashboard,hourly}')=1682
  and jsonb_array_length(payload#>'{dashboard,sessions}')=500 from public.snapshots),
  'full 35-day fine/hourly boundary buckets and 500 sessions remain publishable');
select pg_temp.publish(date_trunc('milliseconds',clock_timestamp())+interval '5 seconds',
  '{"live":{"claude":{"ok":true,"ts":1,"info":{"windows":2}},"codex":{"ok":true,"ts":1,"info":{"ts":1,"planType":null,"credits":{"hasCredits":false,"unlimited":false,"balance":"0.00"},"resetCredits":null,"reached":null}},"codexInfo":{"ts":1,"planType":null,"credits":null,"resetCredits":null,"reached":null},"status":{"ts":1,"pages":[{"id":"claude","name":"Claude","url":"https://status.claude.com","indicator":"none","description":"Operational"}]}}}');
select pg_temp.assert((select payload#>'{live,codexInfo,resetCredits}'='null'::jsonb from public.snapshots),'typed provider info keeps its optional null semantics');

reset role;
rollback;
\echo 'All cloud SQL security/integration assertions passed; fixtures rolled back.'
