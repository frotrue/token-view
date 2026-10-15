-- Only the disposable test runner uses this committed, synthetic fixture.
-- Two independent SQL connections exercise PostgreSQL row-lock rechecks.
\set ON_ERROR_STOP on
begin;
create schema token_view_test;
revoke all on schema token_view_test from public;
grant usage on schema token_view_test to authenticated;
create table token_view_test.state (
  payload jsonb not null, base_capture timestamptz not null,
  old_request timestamptz not null, new_request timestamptz not null
);
insert into token_view_test.state values (
  pg_read_file('/tmp/native-snapshot.json')::jsonb,
  date_trunc('milliseconds',clock_timestamp())-interval '3 minutes',
  clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute');
grant select on table token_view_test.state to authenticated;
create function token_view_test.publish_at(captured timestamptz) returns timestamptz
language sql set search_path = '' as $$
  select public.publish_snapshot((payload#>>'{device,id}')::uuid,payload#>>'{device,name}',captured,
    jsonb_set(payload,'{capturedAt}',to_jsonb(trunc(extract(epoch from captured)*1000))))
    from token_view_test.state
$$;
revoke all on function token_view_test.publish_at(timestamptz) from public;
grant execute on function token_view_test.publish_at(timestamptz) to authenticated;
insert into auth.users(id,email) values ('44444444-4444-4444-4444-444444444444','concurrency-test@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',true);
select token_view_test.publish_at(base_capture) from token_view_test.state;
reset role;
insert into public.refresh_requests(user_id,device_id,requested_at)
  select '44444444-4444-4444-4444-444444444444',(payload#>>'{device,id}')::uuid,old_request from token_view_test.state;
commit;
