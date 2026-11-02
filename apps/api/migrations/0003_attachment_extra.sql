-- Latest Feishu attachment permission parameter; audio bytes remain outside PostgreSQL.
alter table asset_versions add column if not exists download_extra text;
