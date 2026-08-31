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
