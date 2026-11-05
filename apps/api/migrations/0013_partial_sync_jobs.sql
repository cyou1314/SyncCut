-- Distinguish a fully completed sync job from a sync run with record-level failures.
alter table sync_jobs drop constraint if exists sync_jobs_status_check;
alter table sync_jobs add constraint sync_jobs_status_check
  check (status in ('queued','leased','running','downloading','verifying','importing','applying','succeeded','partial','completed','failed','cancelled'));
