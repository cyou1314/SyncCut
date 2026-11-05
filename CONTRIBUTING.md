# Contributing

Thanks for helping improve SyncCut.

## Architecture rules

1. Feishu Bitable is the source of truth for team projects and audio assets.
2. SyncCut Web is an admin/diagnostics console, not a replacement for Feishu documents.
3. Keep all tenant-owned records, connections, devices, jobs, and events tenant-scoped.
4. Keep Feishu App Secrets and tokens on the server only.
5. Use Bitable workflow HTTP notifications plus reconciliation; do not assume unsupported event types.
6. Never overwrite source media or the original Jianying project.
7. Do not add a Jianying or CapCut CLI workflow.
8. Review dependency licenses before adding third-party code or assets.

## Pull request expectations

- Keep changes focused.
- Explain user-visible behavior and affected modules.
- State what was tested and what was not tested.
- Never include user media, credentials, cookies, or private project files.
