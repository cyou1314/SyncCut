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

Apply all numbered migrations in order to a dedicated private PostgreSQL database before starting the API.

## Modules

- `src/feishu-auth.mjs`: current self-built-app token provider; server-side only.
- `src/bitable-client.mjs`: Bitable record read and media download adapter.
- `src/bitable-webhook.mjs`: Webhook authentication, validation and event de-duplication.
- `src/credential-crypto.mjs`: AES-256-GCM helper for encrypted credential persistence.
- `src/local-importer.mjs`: local CSV/XLSX + audio-folder/ZIP preview, SHA-256 verification, metadata-only updates and immutable audio versions. See `LOCAL_IMPORT.md`.
- `src/archive-utils.mjs`: XLSX worksheet reader and bounded ZIP audio extraction using the macOS/Linux `unzip` utility.
- `src/server.mjs`: HTTP entrypoint.

## Not implemented yet

- Feishu OAuth login and external app installation.
- Connection management APIs and UI.
- Bitable full-sync and event-processing workers.
- Credential persistence wiring.
- Device pairing and task polling.
- Web UI / PostgreSQL integration for the local import module.
- Jianying UI automation.

The Feishu console is available at `/feishu.html` when `PUBLIC_ORIGIN`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `SYNC_CREDENTIAL_ENCRYPTION_KEY` are configured. Apply every migration first. Feishu OAuth and Bitable operations require real-account verification; see `docs/FEISHU_APP_SETUP.md` for limits.
