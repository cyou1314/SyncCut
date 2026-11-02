-- tenants are workspace boundaries. Provisioning ownership is always tenant scoped.
create table if not exists bitable_provisioning (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  creator_member_id uuid not null,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (creator_member_id, tenant_id) references tenant_members(id, tenant_id) on delete restrict
);
