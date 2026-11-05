-- Preserve Feishu episode labels such as EP015 and non-destructive timeline metadata.
alter table media_assets add column if not exists episode_label text;
alter table media_assets add column if not exists timeline_parameters jsonb not null default '{}'::jsonb;
create table if not exists feishu_sync_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connection_id uuid not null,
  status text not null check (status in ('running','completed','partial','failed')),
  imported integer not null default 0,
  duplicates integer not null default 0,
  failed integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (connection_id, tenant_id) references feishu_connections(id, tenant_id) on delete cascade
);
create index if not exists feishu_sync_runs_tenant_idx on feishu_sync_runs(tenant_id, connection_id, started_at desc);
