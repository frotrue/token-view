#!/usr/bin/env bash
set -euo pipefail

# A local daemon, isolated network, tmpfs data, no published ports, no account
# credentials. Cleanup touches only the uniquely named container created here.
backend_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_container="token-view-cloud-beta-pg-${$}-${RANDOM}"
test_logdir="$(mktemp -d /tmp/token-view-cloud-pg.XXXXXX)"
docker_local() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
docker_local info --format '{{.ServerVersion}}' >/dev/null
cleanup() {
  docker_local rm --force "$test_container" >/dev/null 2>&1 || true
  rm -rf -- "$test_logdir"
}
trap cleanup EXIT
docker_local run --detach --name "$test_container" --network none \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=512m \
  postgres:16-alpine >/dev/null
for attempt in {1..50}; do
  # The entrypoint's temporary init server only opens a Unix socket. Checking
  # loopback avoids mistaking that server for the final ready instance.
  if docker_local exec "$test_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  if [[ "$attempt" = 50 ]]; then echo 'PostgreSQL did not become ready.' >&2; exit 1; fi
  sleep 0.2
done
psql_local() { docker_local exec --interactive "$test_container" psql -X --quiet --output=/dev/null -U postgres --set=ON_ERROR_STOP=1 "$@"; }
psql_local < "$backend_root/tests/bootstrap-local.sql"
for migration in "$backend_root"/migrations/*.sql; do psql_local < "$migration"; done
psql_local < "$backend_root/tests/security.sql"
docker_local cp "$backend_root/tests/fixtures/native-snapshot.json" "$test_container:/tmp/native-snapshot.json"
# docker cp can preserve a restrictive workspace umask. This is synthetic,
# public test data; the postgres OS user must be able to read this one file.
docker_local exec "$test_container" chmod 0644 /tmp/native-snapshot.json
psql_local < "$backend_root/tests/native-fixture.sql"
psql_local < "$backend_root/tests/concurrency-fixture.sql"

wait_for_lock_holder() {
  local application="$1"
  for attempt in {1..40}; do
    if [[ "$(docker_local exec "$test_container" psql -X -qAt -U postgres -c \
      "select count(*) from pg_stat_activity where application_name='$application' and wait_event='PgSleep'")" = 1 ]]; then return; fi
    sleep 0.1
  done
  echo "Concurrent test lock holder was not ready: $application" >&2
  return 1
}
check_worker() {
  local worker_pid="$1" worker_log="$2"
  if ! wait "$worker_pid"; then cat "$worker_log" >&2; return 1; fi
}

# Hold the newer snapshot row version while an older writer starts. Its
# ON CONFLICT comparison must be rechecked after waiting for this commit.
psql_local > "$test_logdir/newer.log" 2>&1 <<'SQL' &
set application_name='token_view_test_newer';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',true);
select token_view_test.publish_at(base_capture+interval '2 minutes') from token_view_test.state;
select pg_sleep(5);
commit;
SQL
newer_pid=$!
wait_for_lock_holder token_view_test_newer
psql_local <<'SQL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',true);
do $$
begin
  begin
    perform token_view_test.publish_at(base_capture+interval '1 minute') from token_view_test.state;
    raise exception 'FAIL: concurrent stale snapshot was accepted';
  exception when invalid_parameter_value then
    raise notice 'PASS: concurrent stale upload rejected after newer writer commits';
  end;
end
$$;
commit;
SQL
check_worker "$newer_pid" "$test_logdir/newer.log"

# Advance the synthetic request row while keeping its lock. A late exact old
# acknowledgement initially sees the old eligible row, waits for the lock, and
# must then leave the new row pending. The administrator fixture update models
# the conflicting row version; production clients cannot write this table.
psql_local > "$test_logdir/request.log" 2>&1 <<'SQL' &
set application_name='token_view_test_request';
begin;
update public.refresh_requests set requested_at=(select new_request from token_view_test.state)
  where user_id='44444444-4444-4444-4444-444444444444';
select pg_sleep(5);
commit;
SQL
request_pid=$!
wait_for_lock_holder token_view_test_request
psql_local <<'SQL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','44444444-4444-4444-4444-444444444444',true);
do $$
begin
  if (select public.acknowledge_refresh((payload#>>'{device,id}')::uuid,old_request) from token_view_test.state) then
    raise exception 'FAIL: concurrent old acknowledgement erased the newer request';
  end if;
  if not exists(select 1 from public.refresh_requests r,token_view_test.state s
    where r.requested_at=s.new_request and r.handled_at is null) then
    raise exception 'FAIL: newer request was not left pending';
  end if;
  if not exists(select 1 from public.snapshots p,token_view_test.state s
    where p.captured_at=s.base_capture+interval '2 minutes') then
    raise exception 'FAIL: newer snapshot was not preserved';
  end if;
  raise notice 'PASS: concurrent old acknowledgement rechecks timestamp and preserves newer pending request';
end
$$;
commit;
SQL
check_worker "$request_pid" "$test_logdir/request.log"
echo 'Cloud SQL security, native fixture and two-session concurrency tests passed.'
