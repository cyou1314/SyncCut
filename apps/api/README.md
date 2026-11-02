# SyncCut API

Node.js 22+ control-plane service.

## Current endpoints

- `GET /health` — checks API and PostgreSQL availability.
- `POST /webhooks/feishu/bitable/:connectionId` — receives a Bitable workflow/automation HTTP notification, validates its per-connection Bearer secret, validates the record reference, and stores an idempotent event in `feishu_event_inbox`.

The Webhook endpoint deliberately returns quickly. A background worker that reads the event inbox, fetches the full Bitable record and attachments, and updates the asset index is a subsequent implementation step.

## Local setup

```bash
cp .env.example .env
# Fill DATABASE_URL and server-only Feishu credentials.
npm install
npm test
npm start
```

Apply `migrations/0001_feishu_control_plane.sql` to a dedicated private PostgreSQL database before starting the API.

## Modules

- `src/feishu-auth.mjs`: current self-built-app token provider; server-side only.
- `src/bitable-client.mjs`: Bitable record read and media download adapter.
- `src/bitable-webhook.mjs`: Webhook authentication, validation and event de-duplication.
- `src/credential-crypto.mjs`: AES-256-GCM helper for encrypted credential persistence.
- `src/server.mjs`: HTTP entrypoint.

## Not implemented yet

- Feishu OAuth login and external app installation.
- Connection management APIs and UI.
- Bitable full-sync and event-processing workers.
- Credential persistence wiring.
- Device pairing and task polling.
- Jianying UI automation.
