-- M2.3: one-time, tenant-scoped Mac device pairing codes.
create table if not exists device_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  created_by_member_id uuid not null,
  code_hash char(64) not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (created_by_member_id,tenant_id)
    references tenant_members(id,tenant_id) on delete cascade
);

create index if not exists device_pairing_codes_tenant_expiry_idx
  on device_pairing_codes (tenant_id,expires_at)
  where consumed_at is null;
