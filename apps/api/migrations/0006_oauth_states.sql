-- State and browser-session identifiers are stored only as hashes. Verifiers are encrypted.
create table if not exists feishu_oauth_states (
  state_hash char(64) primary key,
  session_hash char(64) not null,
  verifier_ciphertext bytea not null,
  verifier_nonce bytea not null,
  verifier_tag bytea not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists feishu_oauth_states_expiry_idx on feishu_oauth_states(expires_at);
