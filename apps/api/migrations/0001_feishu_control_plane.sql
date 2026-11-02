-- SyncCut Feishu-first control plane.
-- PostgreSQL is private and accessed only by the API service.
-- Feishu Bitable remains the source of truth for project and asset metadata.

create extension if not exists pgcrypto;

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  feishu_tenant_key text unique,
  display_name text not null,
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  feishu_user_id text not null,
  display_name text not null default '',
  role text not null check (role in ('owner','admin','editor','editorial','viewer')),
  status text not null default 'active' check (status in ('active','suspended','removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, feishu_user_id),
  unique (id, tenant_id)
);

create table if not exists feishu_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  app_mode text not null check (app_mode in ('custom_app','store_app')),
  token_mode text not null check (token_mode in ('tenant_access_token','user_access_token')),
  app_id text not null,
  app_token text not null,
  table_id text not null,
  field_mapping jsonb not null default '{}'::jsonb,
  credential_ciphertext bytea,
  credential_nonce bytea,
  credential_tag bytea,
  token_expires_at timestamptz,
  webhook_secret_hash char(64) not null,
  connected_by_member_id uuid,
  status text not null default 'active' check (status in ('active','needs_reauth','revoked','error')),
  last_full_sync_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, app_token, table_id),
  foreign key (connected_by_member_id, tenant_id)
    references tenant_members(id, tenant_id) on delete restrict
);

create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  connection_id uuid not null,
  record_id text not null,
  name text not null,
  kind text not null check (kind in ('music','sfx','voice','ambience')),
  project_name text,
  episode_number integer check (episode_number is null or episode_number > 0),
  scene_name text,
  shot_id text,
  tags text[] not null default '{}',
  notes text,
  source_fields jsonb not null default '{}'::jsonb,
  source_modified_at timestamptz,
  current_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, record_id),
  unique (id, tenant_id),
  foreign key (connection_id, tenant_id)
    references feishu_connections(id, tenant_id) on delete cascade
);

create table if not exists asset_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  asset_id uuid not null,
  version_number integer not null check (version_number > 0),
  file_token text not null,
  original_filename text,
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  sample_rate integer check (sample_rate is null or sample_rate > 0),
  channels smallint check (channels is null or channels between 1 and 32),
  sha256 char(64),
  source_modified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (asset_id, version_number),
  unique (id, tenant_id),
  foreign key (asset_id, tenant_id)
    references media_assets(id, tenant_id) on delete cascade
);

create table if not exists sync_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  device_name text not null,
  device_token_hash char(64) not null,
  app_version text,
  macos_version text,
  jianying_version text,
  status text not null default 'active' check (status in ('active','revoked','offline')),
  last_seen_at timestamptz,
  paired_at timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, device_token_hash)
);

create table if not exists sync_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  connection_id uuid,
  device_id uuid,
  job_type text not null check (job_type in ('refresh_record','full_sync','import_media','apply_timeline')),
  status text not null default 'queued'
    check (status in ('queued','downloading','verifying','importing','applying','completed','failed','cancelled')),
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_message text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (tenant_id, idempotency_key),
  foreign key (connection_id, tenant_id)
    references feishu_connections(id, tenant_id) on delete restrict,
  foreign key (device_id, tenant_id)
    references sync_devices(id, tenant_id) on delete restrict
);

create table if not exists feishu_event_inbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  connection_id uuid not null,
  event_key char(64) not null,
  event_type text not null,
  record_id text not null,
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued','processing','completed','failed')),
  attempts integer not null default 0,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (connection_id, event_key),
  foreign key (connection_id, tenant_id)
    references feishu_connections(id, tenant_id) on delete cascade
);

create table if not exists activity_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor_member_id uuid,
  event_type text not null,
  target_type text,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (actor_member_id, tenant_id)
    references tenant_members(id, tenant_id) on delete restrict
);

create index if not exists tenant_members_user_idx
  on tenant_members(feishu_user_id, tenant_id);
create index if not exists connections_tenant_status_idx
  on feishu_connections(tenant_id, status);
create index if not exists assets_tenant_updated_idx
  on media_assets(tenant_id, updated_at desc);
create index if not exists asset_versions_asset_idx
  on asset_versions(asset_id, version_number desc);
create index if not exists devices_tenant_status_idx
  on sync_devices(tenant_id, status);
create index if not exists jobs_device_status_idx
  on sync_jobs(device_id, status, created_at);
create index if not exists events_queue_idx
  on feishu_event_inbox(status, received_at);
create index if not exists events_tenant_record_idx
  on feishu_event_inbox(tenant_id, record_id, received_at desc);

comment on table tenants is 'One SyncCut customer workspace; maps to a Feishu tenant/team.';
comment on table feishu_connections is 'A tenant-scoped Feishu Bitable connection. Credentials are encrypted by the API.';
comment on table media_assets is 'Derived index of Feishu Bitable records; Feishu remains the source of truth.';
comment on table asset_versions is 'Immutable observations of Bitable attachment versions.';
comment on table feishu_event_inbox is 'Idempotent inbound Bitable workflow notifications.';
comment on table sync_jobs is 'Tenant-scoped work queue for API and Mac agent jobs.';
