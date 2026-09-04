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

-- Whether a ranking still describes the field cannot be answered from
-- `created_at`. Re-ranking upserts this row, which leaves the creation time
-- alone, and overriding a criterion updates `evaluations` without touching
-- its creation time either — so a dashboard comparing the two would latch on
-- "out of date" and never clear. These record when the row last actually
-- changed, which is the question being asked.
--
-- Added without a default so existing rows can be backfilled from
-- `created_at` rather than all reading as "changed just now"; the default and
-- the not-null go on afterwards. Re-running this file is a no-op: the not-null
-- means the backfill matches nothing the second time.
alter table public.evaluations
  add column if not exists updated_at timestamptz;
update public.evaluations set updated_at = coalesce(created_at, now()) where updated_at is null;
alter table public.evaluations alter column updated_at set default now();
alter table public.evaluations alter column updated_at set not null;

alter table public.comparisons
  add column if not exists updated_at timestamptz;
update public.comparisons set updated_at = coalesce(created_at, now()) where updated_at is null;
alter table public.comparisons alter column updated_at set default now();
alter table public.comparisons alter column updated_at set not null;

-- Exactly which evaluations a ranking was built from: `{ response_id:
-- updated_at }` for every row the compare route read before it called the
-- model. A ranking is current iff each of those rows is unchanged and none
-- have been added or removed.
--
-- Per row, not a watermark. This row's own `updated_at` is when the ranking
-- was *saved*, a model call after its inputs were read; and a single "newest
-- input" timestamp is not safe either, because `now()` is a transaction's
-- start time, not its commit order — an override that started first and
-- committed last carries a timestamp older than a watermark taken between the
-- two. Recording each version read makes no ordering assumption at all.
--
-- Deliberately not backfilled. Nothing recorded what an existing ranking
-- saw, and `evaluations.updated_at` for old rows is itself a backfill from
-- `created_at`, so a map built now would assert that every pre-migration
-- override happened before the ranking — the one thing it cannot know. Null
-- means "does not say", the screens report that as out of date, and one
-- re-rank records the fact properly. (The rubric stamp on evaluations below
-- *is* backfilled, on the opposite trade: leaving it unknown would send every
-- existing owner to re-score every proposal, and a re-rank is one call.)
alter table public.comparisons
  drop column if exists evaluations_as_of;
alter table public.comparisons
  add column if not exists evaluation_revisions jsonb;

-- Which endpoint actually served each model call, as the host of AI_BASE_URL
-- at the time (`api.fireworks.ai` for the default). The screens say where an
-- owner's documents went, and that cannot be read off the model id: the same
-- `accounts/fireworks/models/...` id routed through a custom gateway ran
-- somewhere else. Null means "not recorded", and the screens then name the
-- model and claim nothing about hosting.
--
-- Not backfilled: nothing recorded it. If every row in this database was
-- produced through the default endpoint — true for a deployment that never
-- set AI_BASE_URL — the statement below records that; run it deliberately.
--   update public.evaluations set served_by = 'api.fireworks.ai' where served_by is null;
--   update public.comparisons set served_by = 'api.fireworks.ai' where served_by is null;
alter table public.evaluations
  add column if not exists served_by text;
alter table public.comparisons
  add column if not exists served_by text;

-- When the rubric's criteria last changed — not when its row was last
-- written. Accepting a rubric flips `edited_by_user` and rewrites `criteria`
-- unchanged, and that must not read as a change every score was made
-- against, so the trigger below fires only when `criteria` actually differ.
alter table public.rubrics
  add column if not exists updated_at timestamptz;
update public.rubrics set updated_at = coalesce(created_at, now()) where updated_at is null;
alter table public.rubrics alter column updated_at set default now();
alter table public.rubrics alter column updated_at set not null;

-- Which rubric an evaluation was scored against, as that rubric's
-- `updated_at`, recorded by the scoring route at the time. A fact rather
-- than an inference: comparing the evaluation's own update time with the
-- rubric's would call an evaluation current the moment one criterion was
-- overridden, though every other score in it still came from the old rubric.
--
-- Backfilled from the current rubric, so rows scored before this column
-- existed read as current. That is the best available answer for them; the
-- alternative is asking every existing owner to re-score everything.
alter table public.evaluations
  add column if not exists rubric_updated_at timestamptz;
update public.evaluations e
  set rubric_updated_at = r.updated_at
  from public.rubrics r
  where r.rfp_id = e.rfp_id and e.rubric_updated_at is null;

-- One row per uploaded object, as a backstop to the claims at the end of this
-- file. Paths carry a millisecond timestamp, so rows the app wrote are already
-- distinct — but the columns are writable through the API by their owner, so
-- a populated deployment could hold duplicates that would make the index
-- build fail and abort this whole run. Writes are locked out for the rest of
-- the transaction, duplicates beyond the oldest are given a distinguishing
-- suffix rather than deleted, and only then are the indexes built.
lock table public.responses in share row exclusive mode;
lock table public.rfps in share row exclusive mode;
update public.responses r
   set file_path = r.file_path || '#duplicate-' || r.id
  from (
    select id, row_number() over (partition by file_path order by created_at, id) as n
      from public.responses
  ) d
 where d.id = r.id and d.n > 1;
update public.rfps r
   set rfp_file_path = r.rfp_file_path || '#duplicate-' || r.id
  from (
    select id, row_number() over (partition by rfp_file_path order by created_at, id) as n
      from public.rfps where rfp_file_path is not null
  ) d
 where d.id = r.id and d.n > 1;
create unique index if not exists responses_file_path_key
  on public.responses (file_path);
create unique index if not exists rfps_rfp_file_path_key
  on public.rfps (rfp_file_path)
  where rfp_file_path is not null;


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

-- AI usage: users can see their own usage and nothing more. No insert, update
-- or delete policy — rows are written only by reserve_ai_call (see the guest
-- sessions section below), and a caller must not be able to erase their way
-- back under the limit.
alter table public.ai_usage enable row level security;
drop policy if exists "ai_usage_select_own" on public.ai_usage;
create policy "ai_usage_select_own" on public.ai_usage
  for select using (auth.uid() = user_id);
drop policy if exists "ai_usage_insert_own" on public.ai_usage;

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

-- Same function, for the two tables whose freshness the dashboard compares.
drop trigger if exists evaluations_touch_updated_at on public.evaluations;
create trigger evaluations_touch_updated_at
  before update on public.evaluations
  for each row execute function public.touch_updated_at();

drop trigger if exists comparisons_touch_updated_at on public.comparisons;
create trigger comparisons_touch_updated_at
  before update on public.comparisons
  for each row execute function public.touch_updated_at();

-- Rubrics only when the criteria change: see the column's note above.
drop trigger if exists rubrics_touch_updated_at on public.rubrics;
create trigger rubrics_touch_updated_at
  before update on public.rubrics
  for each row
  when (old.criteria is distinct from new.criteria)
  execute function public.touch_updated_at();

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
  guest_rfp_limit integer not null default 3,
  guest_file_limit integer not null default 12
);
insert into public.ai_limits (id) values (true) on conflict (id) do nothing;
alter table public.ai_limits add column if not exists
  guest_file_limit integer not null default 12;
-- How many times per rolling hour one account may send a document for
-- parsing, counted when the attempt is made rather than when it succeeds, so
-- a request that fails after the parse still spent one. Members generous,
-- guests in line with their file cap.
alter table public.ai_limits add column if not exists
  member_upload_hourly_limit integer not null default 60;
alter table public.ai_limits add column if not exists
  guest_upload_hourly_limit integer not null default 12;
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

-- Reservations are written exclusively by reserve_ai_call below, never by the
-- client. With a direct INSERT policy in place, a caller could seed their own
-- ai_usage with a far-future created_at: the row still falls inside the rolling
-- window, so it counts toward the cap, and the retry calculation derived from
-- it overflowed `integer` and raised. Every later reservation for that account
-- then failed, and a failed reservation used to be treated as permission to
-- proceed — turning a self-inflicted poisoning into an uncapped AI budget.
--
-- Three things close that off: no client writes (here), a retry value that
-- cannot overflow (retry_after_seconds below), and a reservation failure that
-- denies rather than allows (src/lib/rate-limit.ts).
drop policy if exists "ai_usage_insert_own" on public.ai_usage;
revoke insert, update, delete on public.ai_usage from authenticated, anon;

-- Records the IP a call came from so the per-IP guest ceiling below has
-- something to count. Hashed application-side with a server-held secret — the
-- raw address is never stored, and only guest calls record one at all.
alter table public.ai_usage
  add column if not exists ip_hash text;

create index if not exists ai_usage_ip_created_idx
  on public.ai_usage (ip_hash, created_at desc)
  where ip_hash is not null;

-- Seconds until the oldest call in the window ages out, clamped to the window
-- itself. The clamp happens in numeric space, before the cast: an unclamped
-- `ceil(...)::integer` overflows on any far-future timestamp, and an exception
-- here is worth strictly less than a slightly wrong retry hint.
create or replace function public.retry_after_seconds(p_oldest timestamptz)
returns integer
language sql
stable
as $$
  select least(
    3600::numeric,
    greatest(1::numeric, ceil(extract(epoch from (p_oldest + interval '1 hour' - now()))))
  )::integer;
$$;

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
  if not found then
    -- Every limit would be null, every "used >= limit" comparison false, and
    -- the guard would fail open. Refuse instead; rate-limit.ts denies on error.
    raise exception 'reserve_ai_call: public.ai_limits has no row';
  end if;

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
      'retry_after_seconds', public.retry_after_seconds(v_oldest)
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
        'retry_after_seconds', public.retry_after_seconds(v_ip_oldest)
      );
    end if;
  end if;

  -- Members are exempt from the IP ceiling, so recording their address would
  -- only let their own calls exhaust it for everyone else: two members working
  -- from one office used to lock out every guest on that network, including one
  -- who had made no calls at all. Storing nothing for them is also less data
  -- retained about signed-in users than the guard needs.
  insert into public.ai_usage (user_id, action, ip_hash)
  values (v_user, p_action, case when v_guest then p_ip_hash end);

  return jsonb_build_object(
    'allowed', true,
    'scope', case when v_guest then 'guest' else 'member' end,
    'limit', v_limit,
    'used', v_used + 1,
    'retry_after_seconds', 0
  );
end;
$$;

-- Hosted Supabase grants EXECUTE on every new public function to anon and
-- authenticated through default privileges. Those are explicit grants, so
-- revoking from PUBLIC alone leaves them in place — each role has to be named.
revoke all on function public.reserve_ai_call(text, text, integer) from public, anon, authenticated;
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

revoke all on function public.can_create_rfp() from public, anon, authenticated;
grant execute on function public.can_create_rfp() to authenticated;

-- The cap functions count per owner on every guest insert, and the RLS
-- policies filter on the same columns for every read.
create index if not exists rfps_owner_id_idx on public.rfps (owner_id);
create index if not exists responses_rfp_id_idx on public.responses (rfp_id);

-- Supersedes the policy of the same name defined earlier in this file.
drop policy if exists "rfps_insert_own" on public.rfps;
create policy "rfps_insert_own" on public.rfps
  for insert with check (auth.uid() = owner_id and public.can_create_rfp());

-- ============================================
-- Guest storage and response caps
-- ============================================
-- Capping rows in public.rfps does not cap what a guest can store. The storage
-- policies accept any object under the caller's own UUID prefix, and a guest
-- holds an ordinary JWT — so they can PUT straight at the Storage API without
-- going through this app at all, and can delete their rfps rows and repeat
-- while the objects stay behind. The bound has to sit on the objects.

create or replace function public.can_upload_file()
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

  select guest_file_limit into v_limit from public.ai_limits where id;

  select count(*) into v_used
    from storage.objects
   where bucket_id = 'rfp-files'
     and (storage.foldername(name))[1] = (select auth.uid()::text);

  return v_used < v_limit;
end;
$$;

revoke all on function public.can_upload_file() from public, anon, authenticated;
grant execute on function public.can_upload_file() to authenticated;

-- Responses carry no per-RFP limit of their own, so a guest holding three RFPs
-- could otherwise insert rows against them without end. Cheap to bound, and it
-- keeps the row count in step with the file count.
create or replace function public.can_create_response()
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

  select guest_file_limit into v_limit from public.ai_limits where id;

  select count(*) into v_used
    from public.responses r
    join public.rfps f on f.id = r.rfp_id
   where f.owner_id = (select auth.uid());

  return v_used < v_limit;
end;
$$;

revoke all on function public.can_create_response() from public, anon, authenticated;
grant execute on function public.can_create_response() to authenticated;

-- Supabase ships storage.objects with row-level security enabled, and every
-- storage policy in this file is inert without it. Asserted rather than assumed
-- because the failure is silent: the policies still create, still look right in
-- the dashboard, and enforce nothing.
--
-- Checked rather than set: on hosted Supabase storage.objects is owned by
-- supabase_storage_admin, so `alter table ... enable row level security` fails
-- with "must be owner of table objects" from the SQL editor and the Management
-- API alike, and takes the whole (transactional) run down with it.
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) then
    raise exception 'storage.objects has row-level security disabled; every storage policy in this file would enforce nothing';
  end if;
end $$;

-- Both supersede the policies of the same name defined earlier in this file.
drop policy if exists "users upload own files" on storage.objects;
create policy "users upload own files" on storage.objects
  for insert with check (
    bucket_id = 'rfp-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and public.can_upload_file()
  );

drop policy if exists "responses_insert_own" on public.responses;
create policy "responses_insert_own" on public.responses
  for insert with check (
    exists (
      select 1 from public.rfps
       where rfps.id = responses.rfp_id and rfps.owner_id = auth.uid()
    )
    and public.can_create_response()
  );

-- Size and type ceilings enforced by Storage itself, which is the only layer a
-- direct PUT cannot route around. src/app/api/upload-rfp checks both, but that
-- check only runs for uploads that come through the app.
update storage.buckets
   set file_size_limit = 26214400,          -- 25 MB, matching the upload routes
       allowed_mime_types = array['application/pdf']
 where id = 'rfp-files';

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
-- the project's monthly active users, so they need sweeping. A saved account is
-- never in scope: attaching an email clears is_anonymous, so it drops out of
-- these queries the moment it is saved.

-- Staleness is measured from last activity, not from signup. An anonymous
-- session stays valid as long as its refresh token is used, so a guest who
-- started five weeks ago may have uploaded something minutes ago — deleting on
-- created_at alone would take live work out from under them mid-session.
--
-- Activity is read from this project's own tables rather than from auth
-- internals. That misses a guest who only ever reads, which is the acceptable
-- edge: the sweep runs on a 30-day window, and unsaved guest work is documented
-- as impermanent precisely because nothing links it to a person.
create or replace function public.stale_guest_ids(
  p_older_than interval default interval '30 days'
)
returns setof uuid
language sql
security definer
set search_path = public
as $$
  select u.id
    from auth.users u
   where u.is_anonymous
     and greatest(
           u.created_at,
           coalesce((select max(greatest(r.created_at, r.updated_at))
                       from public.rfps r where r.owner_id = u.id), u.created_at),
           coalesce((select max(resp.created_at)
                       from public.responses resp
                       join public.rfps r2 on r2.id = resp.rfp_id
                      where r2.owner_id = u.id), u.created_at),
           coalesce((select max(a.created_at)
                       from public.ai_usage a where a.user_id = u.id), u.created_at)
         ) < now() - p_older_than;
$$;

-- Objects still held by stale guests, for the purge script to remove through
-- the Storage API. Deleting rows from storage.objects in SQL drops only the
-- metadata — the payload stays in the bucket, and without the row nothing is
-- left to find it by. So this lists; it does not delete.
create or replace function public.stale_guest_files(
  p_older_than interval default interval '30 days'
)
returns table (object_name text)
language sql
security definer
set search_path = public
as $$
  select o.name
    from storage.objects o
    join public.stale_guest_ids(p_older_than) g
      on (storage.foldername(o.name))[1] = g::text
   where o.bucket_id = 'rfp-files';
$$;

-- Deletes stale guests and, by cascade, their RFPs, responses and evaluations.
--
-- Deliberately skips any guest who still has objects in the bucket: deleting
-- the user would strand those bytes with no owner and no way to bill or reclaim
-- them. Run scripts/purge-stale-guests.mjs, which removes the files through the
-- Storage API first and then calls this — or run this on its own, where it will
-- safely clear only the guests who never uploaded anything.
create or replace function public.delete_stale_guests(
  p_older_than interval default interval '30 days'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with deletable as (
    select g as id
      from public.stale_guest_ids(p_older_than) g
     where not exists (
       select 1 from storage.objects o
        where o.bucket_id = 'rfp-files'
          and (storage.foldername(o.name))[1] = g::text
     )
  )
  delete from auth.users
   where id in (select id from deletable);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Operator-only. Revoking from PUBLIC is not enough on hosted Supabase, where
-- anon and authenticated hold explicit EXECUTE grants by default — left in
-- place, anyone holding the public anon key could call delete_stale_guests
-- over PostgREST. service_role keeps its grant for scripts/purge-stale-guests.mjs.
revoke all on function public.stale_guest_ids(interval) from public, anon, authenticated;
revoke all on function public.stale_guest_files(interval) from public, anon, authenticated;
revoke all on function public.delete_stale_guests(interval) from public, anon, authenticated;

-- ============================================
-- Upload claims
-- ============================================
-- Placed last: `claim_upload` declares a `public.ai_limits%rowtype` and calls
-- `public.is_guest()`, both defined above, and a fresh project runs this file
-- top to bottom.
-- The upload routes receive a storage path from the browser and read the
-- object back to parse it. Without a claim, the same path could be posted
-- again and again, each request reading and parsing up to 25 MB. A row in
-- `responses` or `rfps` cannot be the claim: the owner can delete their own
-- rows through the policies above, mid-parse, and post the path again — and a
-- row inserted before parsing is not proof that parsing finished.
--
-- So a claim is a row here, one per stored object that has been sent for
-- processing, for as long as that object exists. Callers cannot touch this
-- table directly: row-level security is on and the only write path is the
-- functions below, which run as the definer. The routes run with the caller's
-- own JWT, so the functions are callable by the caller too, and each one
-- therefore checks a fact the caller cannot fabricate:
--   * `claim_upload` requires the storage object to exist, in the caller's
--     own folder. It refuses a path that is completed or already has an
--     application row, and one in flight. It mints a token and returns it to
--     whoever took the claim; anyone else is told "busy" and gets no token.
--   * `complete_upload` requires the token and an application row for the
--     path, and marks the claim complete. The mark stays: the application row
--     can be deleted by its owner, and without the mark the same object could
--     be posted again and parsed again. It is swept only once the object is
--     gone, so the table tracks live objects and nothing more.
--   * `release_upload` requires the token and deletes an in-flight claim.
-- An in-flight claim older than the routes' maximum duration can only be a
-- function that was killed, so a new request for the same path takes it over
-- — counted against the same cap as a new claim, or a user could bank stale
-- claims and fire them off together. Each user is capped at a few claims in
-- flight, decided under a per-user advisory lock so concurrent requests cannot
-- all pass the count. The browser may read its own claims, minus the token,
-- to tell "still being processed" from "never reached the server".
create table if not exists public.upload_claims (
  path text primary key,
  user_id uuid references auth.users on delete cascade not null,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  token uuid not null default gen_random_uuid()
);
alter table public.upload_claims
  add column if not exists token uuid not null default gen_random_uuid();
alter table public.upload_claims
  add column if not exists completed_at timestamptz;
drop index if exists public.upload_claims_user_inflight;
create index if not exists upload_claims_user_claimed
  on public.upload_claims (user_id, claimed_at);
alter table public.upload_claims enable row level security;
drop policy if exists "users read own upload claims" on public.upload_claims;
create policy "users read own upload claims" on public.upload_claims
  for select using (user_id = (select auth.uid()));
-- The policy says which rows; these say which columns. The token stays with
-- the route that minted it.
revoke all on table public.upload_claims from anon, authenticated;
grant select (path, user_id, claimed_at, completed_at)
  on public.upload_claims to authenticated;

-- Every claim decision that goes ahead is also an attempt, recorded here
-- whether or not the upload then succeeds — a durable per-account budget for
-- parsing, checked before any download. A claim released after a failed parse
-- leaves no claim behind, so without this the failed attempts would be free.
-- Definer-only, like the claims.
create table if not exists public.upload_attempts (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade not null,
  attempted_at timestamptz not null default now()
);
alter table public.upload_attempts enable row level security;
revoke all on table public.upload_attempts from anon, authenticated;
create index if not exists upload_attempts_user_at
  on public.upload_attempts (user_id, attempted_at);

-- Signatures changed since the first versions of these; drop before create.
drop function if exists public.claim_upload(text);
drop function if exists public.complete_upload(text);
drop function if exists public.release_upload(text);
drop function if exists public.complete_upload(text, uuid);
drop function if exists public.release_upload(text, uuid);

-- Whether an application row already records this path.
create or replace function public.upload_path_has_row(p_path text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.responses where file_path = p_path)
      or exists (select 1 from public.rfps where rfp_file_path = p_path);
$$;
-- Hosted Supabase grants execute on new public functions to anon and
-- authenticated by default, so revoking from public alone would leave this
-- definer helper reachable over PostgREST as a row-existence oracle across
-- tenants. Only the functions below, running as the owner, may call it.
revoke all on function public.upload_path_has_row(text) from public, anon, authenticated;

-- Returns {"state": "claimed", "token": "..."} when the path is now the
-- caller's to process; {"state": "busy"} when it is in flight or the caller
-- has too many in flight; {"state": "completed"} when it already has a row;
-- {"state": "missing"} when there is no such object in the caller's folder;
-- {"state": "limited", "retry_after_seconds": n} when the caller has used
-- their hourly parsing budget.
create or replace function public.claim_upload(p_path text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_stale interval := interval '3 minutes';  -- > the routes' maxDuration
  v_max_inflight int := 3;
  v_existing public.upload_claims%rowtype;
  v_token uuid;
  v_limits public.ai_limits%rowtype;
  v_attempt_limit int;
  v_attempts int;
  v_oldest timestamptz;
  v_has_claim boolean := false;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- The path has to be in the caller's own folder; the storage policies say
  -- the same, and this keeps the claims table from being a way round them.
  if split_part(p_path, '/', 1) <> v_user::text then
    raise exception 'path is not the caller''s' using errcode = '42501';
  end if;

  -- One claim decision at a time per user, so the in-flight count below is
  -- taken against everything this user's other requests have already done.
  perform pg_advisory_xact_lock(hashtext('upload_claims:' || v_user::text));

  -- Sweep: this user's in-flight claims abandoned for over a day, completed
  -- claims whose object no longer exists, and attempts older than a day. What
  -- remains is one claim per live object that has been processed or is being
  -- processed, and an hour's worth of attempts to count.
  delete from public.upload_claims c
   where c.user_id = v_user
     and (
       (c.completed_at is null and c.claimed_at < now() - interval '1 day')
       or (c.completed_at is not null and not exists (
             select 1 from storage.objects o
              where o.bucket_id = 'rfp-files' and o.name = c.path))
     );
  delete from public.upload_attempts
   where user_id = v_user and attempted_at < now() - interval '1 day';

  if public.upload_path_has_row(p_path) then
    return jsonb_build_object('state', 'completed');
  end if;

  -- A claim is for an object that exists. Nothing to claim otherwise, and no
  -- row to leave behind for a path someone typed. An in-flight claim for a
  -- path whose object is gone is one a route removed the object for and was
  -- then killed before it could release; it goes here, so the browser's retry
  -- finds nothing and stops instead of seeing a stale claim until the sweep.
  if not exists (
    select 1 from storage.objects
     where bucket_id = 'rfp-files' and name = p_path
  ) then
    delete from public.upload_claims
     where path = p_path and user_id = v_user and completed_at is null;
    return jsonb_build_object('state', 'missing');
  end if;

  select * into v_existing from public.upload_claims where path = p_path for update;
  v_has_claim := found;
  if v_has_claim and v_existing.completed_at is not null then
    -- Processed once already; the object is still there but its row may have
    -- been deleted by its owner. It does not get processed again.
    return jsonb_build_object('state', 'completed');
  end if;
  if v_has_claim and v_existing.claimed_at > now() - v_stale then
    return jsonb_build_object('state', 'busy');
  end if;

  -- The cap counts what this user has in flight, whether the new claim is a
  -- fresh one or a takeover of a stale one.
  if (select count(*) from public.upload_claims
        where user_id = v_user and completed_at is null
          and claimed_at > now() - v_stale and path <> p_path) >= v_max_inflight then
    return jsonb_build_object('state', 'busy');
  end if;

  -- The hourly parsing budget, spent here — before the download, and
  -- whether or not the parse then succeeds.
  select * into v_limits from public.ai_limits where id;
  if not found then
    raise exception 'claim_upload: public.ai_limits has no row';
  end if;
  v_attempt_limit := case when public.is_guest()
    then v_limits.guest_upload_hourly_limit
    else v_limits.member_upload_hourly_limit end;
  select count(*), min(attempted_at) into v_attempts, v_oldest
    from public.upload_attempts
   where user_id = v_user and attempted_at >= now() - interval '1 hour';
  if v_attempts >= v_attempt_limit then
    return jsonb_build_object(
      'state', 'limited',
      'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_oldest + interval '1 hour' - now())))::int)
    );
  end if;
  insert into public.upload_attempts (user_id) values (v_user);

  if v_has_claim then
    -- Abandoned by a killed function: take it over with a fresh token.
    v_token := gen_random_uuid();
    update public.upload_claims
       set user_id = v_user, claimed_at = now(), token = v_token
     where path = p_path;
    return jsonb_build_object('state', 'claimed', 'token', v_token);
  end if;

  v_token := gen_random_uuid();
  insert into public.upload_claims (path, user_id, token) values (p_path, v_user, v_token);
  return jsonb_build_object('state', 'claimed', 'token', v_token);
end;
$$;

-- Completion marks the claim, and only once a row records the path — so a
-- caller with a token but no upload changes nothing.
create or replace function public.complete_upload(p_path text, p_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.upload_claims
     set completed_at = now()
   where path = p_path and token = p_token and completed_at is null
     and public.upload_path_has_row(p_path);
$$;

create or replace function public.release_upload(p_path text, p_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.upload_claims
   where path = p_path and token = p_token and completed_at is null;
$$;

revoke all on function public.claim_upload(text) from public, anon, authenticated;
revoke all on function public.complete_upload(text, uuid) from public, anon, authenticated;
revoke all on function public.release_upload(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_upload(text) to authenticated;
grant execute on function public.complete_upload(text, uuid) to authenticated;
grant execute on function public.release_upload(text, uuid) to authenticated;
