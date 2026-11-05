-- One encrypted OAuth grant per member and workspace. Never store tokens in browser state.
create table if not exists feishu_user_grants (
  tenant_id uuid not null,
  member_id uuid not null,
  ciphertext bytea not null,
  nonce bytea not null,
  tag bytea not null,
  expires_at timestamptz not null,
  status text not null check (status in ('active','refreshing','needs_reauth')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, member_id),
  foreign key (member_id, tenant_id) references tenant_members(id, tenant_id) on delete cascade
);
