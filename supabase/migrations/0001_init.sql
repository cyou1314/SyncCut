create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('admin','editor','editorial','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  content jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('music','sfx','voice','ambience')),
  tags text[] not null default '{}',
  notes text,
  current_version integer not null default 1,
  version integer not null default 1,
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.asset_versions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.media_assets(id) on delete cascade,
  version integer not null,
  storage_path text not null,
  sha256 text not null,
  size_bytes bigint not null,
  duration_ms bigint,
  mime_type text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique(asset_id, version)
);

create table if not exists public.timeline_presets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  placements jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  created_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_name text not null,
  platform text not null default 'macos' check (platform = 'macos'),
  app_version text,
  os_version text,
  jianying_version text,
  last_seen_at timestamptz,
  paired_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  device_id uuid references public.sync_devices(id) on delete set null,
  created_by uuid not null references auth.users(id),
  job_type text not null check (job_type in ('import_media','apply_timeline')),
  status text not null default 'queued'
    check (status in ('queued','downloading','verifying','importing','applying','completed','failed','cancelled')),
  idempotency_key text not null,
  request_payload jsonb not null,
  result_payload jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique(workspace_id, idempotency_key)
);

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  target_type text,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists projects_workspace_idx on public.projects(workspace_id);
create index if not exists media_assets_project_idx on public.media_assets(project_id);
create index if not exists asset_versions_asset_idx on public.asset_versions(asset_id, version desc);
create index if not exists sync_jobs_device_status_idx on public.sync_jobs(device_id, status, created_at);

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace and wm.user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
      and wm.role = any(allowed_roles)
  );
$$;

create or replace function public.project_workspace(target_project uuid)
returns uuid language sql stable security definer set search_path = public
as $$
  select p.workspace_id from public.projects p where p.id = target_project;
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;
alter table public.documents enable row level security;
alter table public.media_assets enable row level security;
alter table public.asset_versions enable row level security;
alter table public.timeline_presets enable row level security;
alter table public.sync_devices enable row level security;
alter table public.sync_jobs enable row level security;
alter table public.activity_events enable row level security;

create policy "members can read workspaces"
on public.workspaces for select to authenticated
using (public.is_workspace_member(id));

create policy "users can create workspaces"
on public.workspaces for insert to authenticated
with check (owner_id = auth.uid());

create policy "admins can update workspaces"
on public.workspaces for update to authenticated
using (public.has_workspace_role(id, array['admin']))
with check (public.has_workspace_role(id, array['admin']));

create policy "members can read memberships"
on public.workspace_members for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "admins can manage memberships"
on public.workspace_members for all to authenticated
using (public.has_workspace_role(workspace_id, array['admin']))
with check (public.has_workspace_role(workspace_id, array['admin']));

create policy "members can read projects"
on public.projects for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "editors can create projects"
on public.projects for insert to authenticated
with check (public.has_workspace_role(workspace_id, array['admin','editor']));

create policy "editors can update projects"
on public.projects for update to authenticated
using (public.has_workspace_role(workspace_id, array['admin','editor']))
with check (public.has_workspace_role(workspace_id, array['admin','editor']));

create policy "admins can delete projects"
on public.projects for delete to authenticated
using (public.has_workspace_role(workspace_id, array['admin']));

create policy "members can read documents"
on public.documents for select to authenticated
using (public.is_workspace_member(public.project_workspace(project_id)));

create policy "editors can manage documents"
on public.documents for all to authenticated
using (public.has_workspace_role(public.project_workspace(project_id), array['admin','editor','editorial']))
with check (public.has_workspace_role(public.project_workspace(project_id), array['admin','editor','editorial']));

create policy "members can read media assets"
on public.media_assets for select to authenticated
using (public.is_workspace_member(public.project_workspace(project_id)));

create policy "editors can manage media assets"
on public.media_assets for all to authenticated
using (public.has_workspace_role(public.project_workspace(project_id), array['admin','editor','editorial']))
with check (public.has_workspace_role(public.project_workspace(project_id), array['admin','editor','editorial']));

create policy "members can read asset versions"
on public.asset_versions for select to authenticated
using (
  public.is_workspace_member(
    public.project_workspace((select ma.project_id from public.media_assets ma where ma.id = asset_id))
  )
);

create policy "editors can add asset versions"
on public.asset_versions for insert to authenticated
with check (
  public.has_workspace_role(
    public.project_workspace((select ma.project_id from public.media_assets ma where ma.id = asset_id)),
    array['admin','editor','editorial']
  )
);

create policy "members can read timeline presets"
on public.timeline_presets for select to authenticated
using (public.is_workspace_member(public.project_workspace(project_id)));

create policy "editors can manage timeline presets"
on public.timeline_presets for all to authenticated
using (public.has_workspace_role(public.project_workspace(project_id), array['admin','editor','editorial']))
with check (public.has_workspace_role(public.project_workspace(project_id), array['admin','editor','editorial']));

create policy "members can read devices"
on public.sync_devices for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "members can read sync jobs"
on public.sync_jobs for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "members can create sync jobs"
on public.sync_jobs for insert to authenticated
with check (created_by = auth.uid() and public.is_workspace_member(workspace_id));

create policy "members can read activity"
on public.activity_events for select to authenticated
using (public.is_workspace_member(workspace_id));

create policy "members can create activity"
on public.activity_events for insert to authenticated
with check (actor_id = auth.uid() and public.is_workspace_member(workspace_id));

-- Device status/job updates and signed download URLs must go through a trusted
-- server endpoint or Edge Function. Never expose the service-role key to clients.

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'media_assets') then
    alter publication supabase_realtime add table public.media_assets;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'asset_versions') then
    alter publication supabase_realtime add table public.asset_versions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_jobs') then
    alter publication supabase_realtime add table public.sync_jobs;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_events') then
    alter publication supabase_realtime add table public.activity_events;
  end if;
end $$;
