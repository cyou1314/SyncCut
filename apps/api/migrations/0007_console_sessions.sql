-- Independent personal workspaces may belong to the same Feishu enterprise.
create table if not exists feishu_personal_workspaces (
  app_id text not null,
  feishu_tenant_key text not null,
  feishu_open_id text not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  member_id uuid not null,
  primary key (app_id,feishu_tenant_key,feishu_open_id),
  unique (tenant_id),
  foreign key (member_id,tenant_id) references tenant_members(id,tenant_id) on delete cascade
);
create table if not exists console_sessions (
  session_hash char(64) primary key,
  tenant_id uuid,
  member_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check ((tenant_id is null) = (member_id is null)),
  foreign key (member_id,tenant_id) references tenant_members(id,tenant_id) on delete cascade
);
create index if not exists console_sessions_expiry_idx on console_sessions(expires_at);
