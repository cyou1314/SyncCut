-- M2.2: turn sync_jobs into a persistent leased task queue and record where
-- each asset version's bytes live in object storage.
-- Cloud worker states (queued/leased/running/succeeded) are added alongside
-- the existing Mac-facing domain states; legacy rows keep their meaning.

alter table sync_jobs
  add column if not exists leased_by text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists max_attempts integer not null default 3,
  add column if not exists updated_at timestamptz not null default now();

alter table sync_jobs drop constraint if exists sync_jobs_status_check;
alter table sync_jobs add constraint sync_jobs_status_check
  check (status in ('queued','leased','running','downloading','verifying','importing','applying','succeeded','completed','failed','cancelled'));

create index if not exists sync_jobs_claim_idx
  on sync_jobs (status, next_attempt_at, created_at)
  where status in ('queued','leased','running');

alter table feishu_event_inbox
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists max_attempts integer not null default 5;

-- asset_versions already carries a sha256 column; M2.2 fills it when the
-- bytes are archived and records the object-storage location alongside.
alter table asset_versions
  add column if not exists storage_key text,
  add column if not exists stored_at timestamptz;

create index if not exists asset_versions_unstored_idx
  on asset_versions (tenant_id, asset_id)
  where storage_key is null;
