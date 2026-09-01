-- Database schema for OpenRFP
-- Run this in the Supabase SQL Editor (Dashboard → SQL → New query)

-- ============================================
-- Extensions
-- ============================================
create extension if not exists "uuid-ossp";

-- ============================================
-- Profiles (extends auth.users)
-- ============================================
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  org_name text,
  role text default 'owner',
  created_at timestamptz default now()
);

-- ============================================
-- RFPs
-- ============================================
create table if not exists public.rfps (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users on delete cascade not null,
  title text not null,
  description text,
  rfp_file_path text not null,
  rfp_text text,
  status text default 'draft' check (status in ('draft', 'rubric_ready', 'evaluating', 'complete')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================
-- Rubrics (one per RFP)
-- ============================================
create table if not exists public.rubrics (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid references public.rfps on delete cascade not null unique,
  criteria jsonb not null,
  ai_generated boolean default true,
  edited_by_user boolean default false,
  locked boolean default false,
  created_at timestamptz default now()
);

-- ============================================
-- Responses (vendor proposals)
-- ============================================
create table if not exists public.responses (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid references public.rfps on delete cascade not null,
  vendor_name text not null,
  file_path text not null,
  extracted_text text,
  ocr_status text default 'unknown' check (ocr_status in ('ok', 'flagged', 'unknown')),
  page_count integer,
  status text default 'pending' check (status in ('pending', 'evaluating', 'evaluated', 'error')),
  created_at timestamptz default now()
);

-- ============================================
-- Evaluations (one per response)
-- ============================================
create table if not exists public.evaluations (
  id uuid primary key default gen_random_uuid(),
  response_id uuid references public.responses on delete cascade not null unique,
  rfp_id uuid references public.rfps on delete cascade not null,
  scores jsonb not null,
  overall_score numeric,
  summary text,
  strengths jsonb,
  weaknesses jsonb,
  model_used text,
  prompt_version text,
  created_at timestamptz default now()
);

-- ============================================
-- Comparisons (one per RFP)
-- ============================================
create table if not exists public.comparisons (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid references public.rfps on delete cascade not null unique,
  ranking jsonb not null,
  comparative_analysis text,
  close_calls jsonb,
  interview_focus_areas jsonb,
  model_used text,
  prompt_version text,
  created_at timestamptz default now()
);

-- Added after the initial schema: `create table if not exists` above is a no-op
-- on existing projects, so bring older deployments forward explicitly.
alter table public.comparisons
  add column if not exists interview_focus_areas jsonb;

-- ============================================
-- Audit Log
-- ============================================
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid references public.rfps on delete cascade,
  user_id uuid references auth.users on delete cascade,
  action text not null,
  details jsonb,
  created_at timestamptz default now()
);

-- ============================================
-- AI usage (rate limiting)
-- ============================================
-- A row is inserted BEFORE each model call, not after, so concurrent requests
-- contend over the INSERT rather than over the several seconds an AI call takes.
create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  action text not null,
  created_at timestamptz default now()
);

create index if not exists ai_usage_user_created_idx
  on public.ai_usage (user_id, created_at desc);

-- ============================================
-- Row Level Security
-- ============================================

-- Profiles: users can only see their own profile
alter table public.profiles enable row level security;
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- RFPs: users can only see/modify their own RFPs
alter table public.rfps enable row level security;
drop policy if exists "rfps_select_own" on public.rfps;
create policy "rfps_select_own" on public.rfps
  for select using (auth.uid() = owner_id);
drop policy if exists "rfps_insert_own" on public.rfps;
create policy "rfps_insert_own" on public.rfps
  for insert with check (auth.uid() = owner_id);
drop policy if exists "rfps_update_own" on public.rfps;
create policy "rfps_update_own" on public.rfps
  for update using (auth.uid() = owner_id);
drop policy if exists "rfps_delete_own" on public.rfps;
create policy "rfps_delete_own" on public.rfps
  for delete using (auth.uid() = owner_id);

-- Rubrics: users can only see/modify rubrics for their own RFPs
alter table public.rubrics enable row level security;
drop policy if exists "rubrics_select_own" on public.rubrics;
create policy "rubrics_select_own" on public.rubrics
  for select using (
    exists (select 1 from public.rfps where rfps.id = rubrics.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "rubrics_insert_own" on public.rubrics;
create policy "rubrics_insert_own" on public.rubrics
  for insert with check (
    exists (select 1 from public.rfps where rfps.id = rubrics.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "rubrics_update_own" on public.rubrics;
create policy "rubrics_update_own" on public.rubrics
  for update using (
    exists (select 1 from public.rfps where rfps.id = rubrics.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "rubrics_delete_own" on public.rubrics;
create policy "rubrics_delete_own" on public.rubrics
  for delete using (
    exists (select 1 from public.rfps where rfps.id = rubrics.rfp_id and rfps.owner_id = auth.uid())
  );

-- Responses: users can only see/modify responses for their own RFPs
alter table public.responses enable row level security;
drop policy if exists "responses_select_own" on public.responses;
create policy "responses_select_own" on public.responses
  for select using (
    exists (select 1 from public.rfps where rfps.id = responses.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "responses_insert_own" on public.responses;
create policy "responses_insert_own" on public.responses
  for insert with check (
    exists (select 1 from public.rfps where rfps.id = responses.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "responses_update_own" on public.responses;
create policy "responses_update_own" on public.responses
  for update using (
    exists (select 1 from public.rfps where rfps.id = responses.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "responses_delete_own" on public.responses;
create policy "responses_delete_own" on public.responses
  for delete using (
    exists (select 1 from public.rfps where rfps.id = responses.rfp_id and rfps.owner_id = auth.uid())
  );

-- Evaluations: users can only see evaluations for their own RFPs
alter table public.evaluations enable row level security;
drop policy if exists "evaluations_select_own" on public.evaluations;
create policy "evaluations_select_own" on public.evaluations
  for select using (
    exists (select 1 from public.rfps where rfps.id = evaluations.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "evaluations_insert_own" on public.evaluations;
create policy "evaluations_insert_own" on public.evaluations
  for insert with check (
    exists (select 1 from public.rfps where rfps.id = evaluations.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "evaluations_update_own" on public.evaluations;
create policy "evaluations_update_own" on public.evaluations
  for update using (
    exists (select 1 from public.rfps where rfps.id = evaluations.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "evaluations_delete_own" on public.evaluations;
create policy "evaluations_delete_own" on public.evaluations
  for delete using (
    exists (select 1 from public.rfps where rfps.id = evaluations.rfp_id and rfps.owner_id = auth.uid())
  );

-- Comparisons: users can only see comparisons for their own RFPs
alter table public.comparisons enable row level security;
drop policy if exists "comparisons_select_own" on public.comparisons;
create policy "comparisons_select_own" on public.comparisons
  for select using (
    exists (select 1 from public.rfps where rfps.id = comparisons.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "comparisons_insert_own" on public.comparisons;
create policy "comparisons_insert_own" on public.comparisons
  for insert with check (
    exists (select 1 from public.rfps where rfps.id = comparisons.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "comparisons_update_own" on public.comparisons;
create policy "comparisons_update_own" on public.comparisons
  for update using (
    exists (select 1 from public.rfps where rfps.id = comparisons.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "comparisons_delete_own" on public.comparisons;
create policy "comparisons_delete_own" on public.comparisons
  for delete using (
    exists (select 1 from public.rfps where rfps.id = comparisons.rfp_id and rfps.owner_id = auth.uid())
  );

-- Audit log: users can only see audit logs for their own RFPs
alter table public.audit_log enable row level security;
drop policy if exists "audit_log_select_own" on public.audit_log;
create policy "audit_log_select_own" on public.audit_log
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.rfps where rfps.id = audit_log.rfp_id and rfps.owner_id = auth.uid())
  );
drop policy if exists "audit_log_insert_own" on public.audit_log;
create policy "audit_log_insert_own" on public.audit_log
  for insert with check (auth.uid() = user_id);

-- AI usage: users can only see and record their own usage. No update or delete
-- policy — a caller must not be able to erase their way back under the limit.
alter table public.ai_usage enable row level security;
drop policy if exists "ai_usage_select_own" on public.ai_usage;
create policy "ai_usage_select_own" on public.ai_usage
  for select using (auth.uid() = user_id);
drop policy if exists "ai_usage_insert_own" on public.ai_usage;
create policy "ai_usage_insert_own" on public.ai_usage
  for insert with check (auth.uid() = user_id);

-- ============================================
-- Auto-create profile on signup
-- ============================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================
-- Keep rfps.updated_at current
-- ============================================
-- The column had a default but nothing ever advanced it, so every row read
-- back as "last updated at creation".
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rfps_touch_updated_at on public.rfps;
create trigger rfps_touch_updated_at
  before update on public.rfps
  for each row execute function public.touch_updated_at();

-- ============================================
-- Storage bucket for RFP and response files
-- ============================================
insert into storage.buckets (id, name, public) values ('rfp-files', 'rfp-files', false)
on conflict (id) do nothing;

-- Storage policies: users can only access files under their own user-id folder.
--
-- Every object is stored under a path whose FIRST segment is the uploader's
-- auth.uid():
--   RFPs:      <user_id>/<timestamp>-<filename>
--   Responses: <user_id>/<rfp_id>/<timestamp>-<filename>
--
-- These policies must compare that first segment against auth.uid(). Checking
-- only `auth.uid() is not null` would let ANY signed-in user list, download,
-- overwrite and delete EVERY other tenant's RFPs and vendor proposals.
drop policy if exists "users upload own files" on storage.objects;
create policy "users upload own files" on storage.objects
  for insert with check (
    bucket_id = 'rfp-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "users read own files" on storage.objects;
create policy "users read own files" on storage.objects
  for select using (
    bucket_id = 'rfp-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "users update own files" on storage.objects;
create policy "users update own files" on storage.objects
  for update using (
    bucket_id = 'rfp-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'rfp-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "users delete own files" on storage.objects;
create policy "users delete own files" on storage.objects
  for delete using (
    bucket_id = 'rfp-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- ============================================
-- Guest (anonymous) sessions
-- ============================================
-- A visitor can run a full evaluation pass before creating an account. Supabase
-- anonymous sign-in gives them a real `auth.users` row and a real JWT, so every
-- policy above — which keys on auth.uid() — applies to them unchanged, and no
-- data has to be migrated when they later attach an email: `updateUser({ email })`
-- converts the SAME user id from anonymous to permanent, and their RFPs,
-- responses and evaluations simply stay theirs.
--
-- The cost of that convenience is that anyone can mint a session, so the limits
-- below are what stand between an open signup path and the project's AI budget.

-- Server-enforced limits. Deliberately a table rather than function constants:
-- the values must live somewhere the browser cannot reach or override. RLS is
-- enabled with NO policies, so PostgREST exposes nothing — only the SECURITY
-- DEFINER functions below (which bypass RLS) can read it. Change a limit with
-- an UPDATE from the SQL editor.
create table if not exists public.ai_limits (
  id boolean primary key default true check (id),
  member_hourly_limit integer not null default 20,
  guest_hourly_limit integer not null default 6,
  guest_ip_hourly_limit integer not null default 12,
  guest_rfp_limit integer not null default 3
);
insert into public.ai_limits (id) values (true) on conflict (id) do nothing;
alter table public.ai_limits enable row level security;

-- Which caller are we looking at? Anonymous sign-in stamps `is_anonymous` into
-- the JWT; a converted (email-attached) user carries false.
create or replace function public.is_guest()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

-- Records the IP a call came from so the per-IP guest ceiling below has
-- something to count. Hashed application-side with a server-held secret — the
-- raw address is never stored.
alter table public.ai_usage
  add column if not exists ip_hash text;

create index if not exists ai_usage_ip_created_idx
  on public.ai_usage (ip_hash, created_at desc)
  where ip_hash is not null;

-- ============================================
-- AI call reservation
-- ============================================
-- Replaces the previous read-then-insert in src/lib/rate-limit.ts, which could
-- let a concurrent burst each observe the same under-limit count and all
-- proceed. Taking the count and the insert inside one transaction, behind an
-- advisory lock, closes that window.
--
-- The effective limit is min(caller's limit, the table above). The caller may
-- only make the cap STRICTER: this function is reachable over PostgREST by any
-- authenticated user, so a limit passed in from outside can never be trusted to
-- raise the ceiling.
create or replace function public.reserve_ai_call(
  p_action text,
  p_ip_hash text default null,
  p_client_limit integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_guest boolean := public.is_guest();
  v_window_start timestamptz := now() - interval '1 hour';
  v_limits public.ai_limits%rowtype;
  v_limit integer;
  v_ip_limit integer;
  v_used integer;
  v_ip_used integer;
  v_oldest timestamptz;
  v_ip_oldest timestamptz;
begin
  if v_user is null then
    raise exception 'reserve_ai_call: no authenticated user';
  end if;

  if p_action not in ('generate_rubric', 'evaluate_response', 'compare_responses') then
    raise exception 'reserve_ai_call: unknown action %', p_action;
  end if;

  select * into v_limits from public.ai_limits where id;

  v_limit := case when v_guest
    then v_limits.guest_hourly_limit
    else v_limits.member_hourly_limit
  end;

  -- A caller-supplied limit may only tighten, never loosen. 0 means "no cap"
  -- on the app side, so it is ignored here rather than treated as a floor.
  if p_client_limit is not null and p_client_limit > 0 then
    v_limit := least(v_limit, p_client_limit);
  end if;

  -- Serialize this caller's reservations. Locks are always taken user-first,
  -- then IP, so two callers sharing an IP cannot deadlock against each other.
  perform pg_advisory_xact_lock(hashtextextended('openrfp:ai_usage:user:' || v_user::text, 0));

  select count(*), min(created_at) into v_used, v_oldest
    from public.ai_usage
   where user_id = v_user
     and created_at >= v_window_start;

  if v_used >= v_limit then
    return jsonb_build_object(
      'allowed', false,
      'scope', 'user',
      'limit', v_limit,
      'used', v_used,
      'retry_after_seconds',
        greatest(1, ceil(extract(epoch from (v_oldest + interval '1 hour' - now())))::integer)
    );
  end if;

  -- Guests only: a per-IP ceiling across every guest session from one address.
  -- The per-user cap alone is no guard when minting another user is a page
  -- reload away. Signed-in members are exempt so a shared office NAT or campus
  -- gateway can't lock a whole organization out of its own account.
  if v_guest and p_ip_hash is not null then
    v_ip_limit := v_limits.guest_ip_hourly_limit;

    perform pg_advisory_xact_lock(hashtextextended('openrfp:ai_usage:ip:' || p_ip_hash, 0));

    -- Counted into their own variables: v_used still has to describe THIS
    -- caller when the success payload is built below, and the app puts that
    -- number in front of them.
    select count(*), min(created_at) into v_ip_used, v_ip_oldest
      from public.ai_usage
     where ip_hash = p_ip_hash
       and created_at >= v_window_start;

    if v_ip_used >= v_ip_limit then
      return jsonb_build_object(
        'allowed', false,
        'scope', 'ip',
        'limit', v_ip_limit,
        'used', v_ip_used,
        'retry_after_seconds',
          greatest(1, ceil(extract(epoch from (v_ip_oldest + interval '1 hour' - now())))::integer)
      );
    end if;
  end if;

  insert into public.ai_usage (user_id, action, ip_hash)
  values (v_user, p_action, p_ip_hash);

  return jsonb_build_object(
    'allowed', true,
    'scope', case when v_guest then 'guest' else 'member' end,
    'limit', v_limit,
    'used', v_used + 1,
    'retry_after_seconds', 0
  );
end;
$$;

revoke all on function public.reserve_ai_call(text, text, integer) from public;
grant execute on function public.reserve_ai_call(text, text, integer) to authenticated;

-- ============================================
-- Guest RFP cap
-- ============================================
-- Bounds how much storage one throwaway session can consume. SECURITY DEFINER
-- because a policy on public.rfps cannot itself SELECT public.rfps — the policy
-- would recurse into evaluating itself.
create or replace function public.can_create_rfp()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_used integer;
begin
  if not public.is_guest() then
    return true;
  end if;

  select guest_rfp_limit into v_limit from public.ai_limits where id;
  select count(*) into v_used from public.rfps where owner_id = auth.uid();

  return v_used < v_limit;
end;
$$;

revoke all on function public.can_create_rfp() from public;
grant execute on function public.can_create_rfp() to authenticated;

-- Supersedes the policy of the same name defined earlier in this file.
drop policy if exists "rfps_insert_own" on public.rfps;
create policy "rfps_insert_own" on public.rfps
  for insert with check (auth.uid() = owner_id and public.can_create_rfp());

-- ============================================
-- Keep profiles.email in step with auth.users
-- ============================================
-- handle_new_user() copies the email at signup, but a guest has none at that
-- point — it arrives later, when they attach one to save their work. Without
-- this the profile row would keep a null email forever.
create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function public.sync_profile_email();

-- ============================================
-- Guest cleanup
-- ============================================
-- Abandoned guest sessions are permanent rows in auth.users and count toward
-- the project's monthly active users, so they need sweeping. Deleting the user
-- cascades to their RFPs, responses and evaluations; storage objects are not
-- covered by that cascade and are removed explicitly first.
--
-- Never touches a guest who attached an email — conversion clears is_anonymous,
-- so a saved account falls out of this query the moment it is saved.
--
-- Run it on a schedule (Dashboard → Database → Cron), e.g. daily at 03:00 UTC:
--   select cron.schedule(
--     'openrfp-delete-stale-guests', '0 3 * * *',
--     $cron$ select public.delete_stale_guests(); $cron$
--   );
create or replace function public.delete_stale_guests(
  p_older_than interval default interval '30 days'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_folders text[];
  v_count integer;
begin
  select array_agg(id) into v_ids
    from auth.users
   where is_anonymous = true
     and created_at < now() - p_older_than;

  if v_ids is null then
    return 0;
  end if;

  select array_agg(id::text) into v_folders from unnest(v_ids) as id;

  delete from storage.objects
   where bucket_id = 'rfp-files'
     and (storage.foldername(name))[1] = any(v_folders);

  delete from auth.users where id = any(v_ids);
  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

revoke all on function public.delete_stale_guests(interval) from public;
