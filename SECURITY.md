# Security Policy

SyncCut handles private production media, Feishu tenant data, access credentials, and local editing projects.

## Reporting a vulnerability

Do not publish access tokens, App Secrets, webhook secrets, private media, project files, or exploit details in a public issue. Use GitHub Security Advisories.

## Security requirements

- Never commit Feishu App Secret, tenant/user access tokens, refresh tokens, database passwords, device tokens, or webhook bearer secrets.
- Store Feishu credentials encrypted at rest; never expose them to browsers or the Mac app.
- Store only SHA-256 hashes of device tokens and per-connection webhook secrets.
- Every tenant-owned query and job must be scoped by the authenticated tenant_id.
- Keep PostgreSQL private; clients must access it only through the API.
- Verify Feishu permissions for each Base. Never make a Base public to bypass authorization.
- Validate and deduplicate inbound automation requests.
- Use HTTPS for all public API endpoints.
- Verify downloaded media using SHA-256 before use.
- Never overwrite source audio, video, or original Jianying projects.
- Timeline operations must run on a project copy.
- Do not read Feishu or Jianying cookies, modify official application bundles, or bypass product permissions.
