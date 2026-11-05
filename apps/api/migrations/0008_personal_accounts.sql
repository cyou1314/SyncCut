-- A personal Feishu identity has no enterprise identity. Keep it structurally
-- separate from enterprise tenant keys instead of inventing a tenant identifier.
create table if not exists feishu_personal_accounts (
  app_id text not null,
  feishu_open_id text not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  member_id uuid not null,
  primary key (app_id,feishu_open_id),
  unique (tenant_id),
  foreign key (member_id,tenant_id) references tenant_members(id,tenant_id) on delete cascade
);
