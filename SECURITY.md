# Security Policy

SyncCut handles private production media and local editing projects.

## Reporting a vulnerability

Do not publish access tokens, private media, project files, or exploit details in a public issue. Contact the repository owner privately through GitHub Security Advisories.

## Security requirements

- Never commit Supabase service-role keys, device tokens, signing keys, or user media.
- Use private storage buckets and short-lived signed URLs.
- Enforce workspace membership and role checks on the server with RLS.
- Store device-token hashes server-side and revoke lost devices.
- Verify downloaded files with SHA-256 before importing.
- Never overwrite source audio or original Jianying projects.
- Execute timeline changes only against a copy and record an audit log.
