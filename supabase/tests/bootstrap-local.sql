-- Disposable vanilla PostgreSQL only. NEVER apply this shim to Supabase.
-- It models the trusted PostgREST JWT context, roles and auth user FK.
\set ON_ERROR_STOP on
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
grant usage on schema public, auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
-- Exercise the migration against permissive defaults like Supabase's defaults.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
