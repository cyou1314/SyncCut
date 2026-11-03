-- M2.3 separates cloud-to-Mac asset transfer from the later Jianying import action.
alter table sync_jobs drop constraint if exists sync_jobs_job_type_check;
alter table sync_jobs add constraint sync_jobs_job_type_check
  check (job_type in ('refresh_record','full_sync','sync_assets','import_media','apply_timeline'));
