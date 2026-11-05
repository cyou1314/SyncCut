-- M2.2 hardening: make webhook event handoff atomic and support one-time secret display.
-- Stop the worker before applying this migration so legacy processing rows can be safely recovered.

alter table sync_jobs add constraint sync_jobs_id_tenant_unique unique (id, tenant_id);

alter table feishu_event_inbox
  add column if not exists job_id uuid;

alter table feishu_event_inbox
  drop constraint if exists feishu_event_inbox_status_check;

alter table feishu_event_inbox
  add constraint feishu_event_inbox_status_check
  check (status in ('queued','processing','enqueued','completed','failed'));

alter table feishu_event_inbox
  add constraint feishu_event_inbox_job_tenant_fk
  foreign key (job_id, tenant_id) references sync_jobs(id, tenant_id) on delete restrict;

-- Previous worker versions could leave rows in processing if the process died
-- after claiming events but before creating their sync job.
update feishu_event_inbox set status='queued' where status='processing';

create index if not exists events_enqueued_job_idx
  on feishu_event_inbox (job_id)
  where job_id is not null;

-- The plaintext secret is never stored. This short-lived encrypted envelope
-- is deleted atomically by the one-time reveal endpoint.
create table if not exists webhook_secret_reveals (
  connection_id uuid primary key,
  tenant_id uuid not null,
  ciphertext bytea not null,
  nonce bytea not null,
  tag bytea not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (connection_id, tenant_id)
    references feishu_connections(id, tenant_id) on delete cascade
);

create index if not exists webhook_secret_reveals_expiry_idx
  on webhook_secret_reveals(expires_at);
