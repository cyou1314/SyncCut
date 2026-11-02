-- M2 cloud foundation: profiles, owner membership bootstrap, audio storage and realtime.
-- This migration is additive. It does not delete or rewrite existing project data.

-- Harden the helper functions used by RLS policies.
create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = (select auth.uid())
      and wm.role = any(allowed_roles)
  );
$$;

create or replace function public.project_workspace(target_project uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.workspace_id
  from public.projects p
  where p.id = target_project;
$$;

create or replace function public.is_workspace_owner(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspaces w
    where w.id = target_workspace
      and w.owner_id = (select auth.uid())
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.has_workspace_role(uuid, text[]) from public, anon;
revoke all on function public.project_workspace(uuid) from public, anon;
revoke all on function public.is_workspace_owner(uuid) from public, anon;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, text[]) to authenticated;
grant execute on function public.project_workspace(uuid) to authenticated;
grant execute on function public.is_workspace_owner(uuid) to authenticated;

-- User profiles. Email addresses remain in Supabase Auth and are not exposed here.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select, update on public.profiles to authenticated;

create or replace function public.are_workspace_colleagues(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs
      on theirs.workspace_id = mine.workspace_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = target_user
  );
$$;

revoke all on function public.are_workspace_colleagues(uuid) from public, anon;
grant execute on function public.are_workspace_colleagues(uuid) to authenticated;

drop policy if exists "users can read own or shared workspace profiles" on public.profiles;
create policy "users can read own or shared workspace profiles"
on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or public.are_workspace_colleagues(id)
);

drop policy if exists "users can update own profile" on public.profiles;
create policy "users can update own profile"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'SyncCut User'
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_sync_cut on auth.users;
create trigger on_auth_user_created_sync_cut
after insert on auth.users
for each row execute function public.handle_new_user();

-- Backfill users that existed before this migration.
insert into public.profiles (id, display_name)
select
  u.id,
  coalesce(
    nullif(u.raw_user_meta_data ->> 'display_name', ''),
    nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
    'SyncCut User'
  )
from auth.users u
on conflict (id) do nothing;

-- Every workspace owner is automatically an admin member.
create or replace function public.add_workspace_owner_as_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'admin')
  on conflict (workspace_id, user_id)
  do update set role = 'admin';

  return new;
end;
$$;

revoke all on function public.add_workspace_owner_as_admin() from public, anon, authenticated;

drop trigger if exists on_workspace_created_add_owner on public.workspaces;
create trigger on_workspace_created_add_owner
after insert on public.workspaces
for each row execute function public.add_workspace_owner_as_admin();

-- Repair any workspace created before the owner-membership trigger existed.
insert into public.workspace_members (workspace_id, user_id, role)
select w.id, w.owner_id, 'admin'
from public.workspaces w
on conflict (workspace_id, user_id)
do update set role = 'admin';

create index if not exists workspace_members_user_id_idx
on public.workspace_members (user_id);

-- Add production metadata fields while preserving the original columns.
alter table public.media_assets
  add column if not exists episode_number integer
    check (episode_number is null or episode_number > 0),
  add column if not exists scene_name text,
  add column if not exists shot_id text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.asset_versions
  add column if not exists original_filename text,
  add column if not exists sample_rate integer
    check (sample_rate is null or sample_rate > 0),
  add column if not exists channels smallint
    check (channels is null or channels between 1 and 32),
  add column if not exists bit_depth smallint
    check (bit_depth is null or bit_depth > 0);

create index if not exists media_assets_kind_project_idx
on public.media_assets (project_id, kind, updated_at desc);

-- Private audio bucket. The 50 MiB application limit is an initial MVP guard;
-- resumable uploads and larger limits will be added with the Mac sync phase.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'sync-cut-assets',
  'sync-cut-assets',
  false,
  52428800,
  array[
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/wave',
    'audio/x-wav',
    'audio/vnd.wave',
    'audio/aiff',
    'audio/x-aiff',
    'audio/mp4',
    'audio/x-m4a',
    'audio/aac',
    'audio/ogg',
    'audio/webm',
    'audio/flac',
    'audio/x-flac'
  ]
)
on conflict (id) do update
set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Object path convention:
-- workspace_id/project_id/asset_id/version_id/original-filename
-- Reads are available to workspace members; writes are restricted to editors.
drop policy if exists "workspace members can read SyncCut audio" on storage.objects;
create policy "workspace members can read SyncCut audio"
on storage.objects for select to authenticated
using (
  bucket_id = 'sync-cut-assets'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id::text = (storage.foldername(name))[1]
      and wm.user_id = (select auth.uid())
  )
);

drop policy if exists "workspace editors can upload SyncCut audio" on storage.objects;
create policy "workspace editors can upload SyncCut audio"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'sync-cut-assets'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id::text = (storage.foldername(name))[1]
      and wm.user_id = (select auth.uid())
      and wm.role in ('admin', 'editor', 'editorial')
  )
);

drop policy if exists "workspace editors can delete SyncCut audio" on storage.objects;
create policy "workspace editors can delete SyncCut audio"
on storage.objects for delete to authenticated
using (
  bucket_id = 'sync-cut-assets'
  and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id::text = (storage.foldername(name))[1]
      and wm.user_id = (select auth.uid())
      and wm.role in ('admin', 'editor', 'editorial')
  )
);

-- Ensure the tables used by the MVP are included in Postgres Changes.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'workspace_members'
  ) then
    alter publication supabase_realtime add table public.workspace_members;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'projects'
  ) then
    alter publication supabase_realtime add table public.projects;
  end if;
end
$$;
