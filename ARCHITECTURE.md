# Architecture

## Components

- `apps/web`: responsive Workbench browser client.
- `workers/api`: authenticated HTTP API and sync endpoints.
- `workers/realtime`: workspace-scoped Durable Objects for ordering and notifications.
- `packages/sync-contracts`: platform-neutral protocol types, validation, and fixtures.
- `packages/domain`: feature models and capability flags.
- `packages/storage`: browser persistence, outbox, cursor, and recovery state.
- `infra`: Wrangler configuration, D1 migrations, R2 bindings, and deployment scripts.

## Data flow

1. A client writes locally and records a durable mutation.
2. The client uploads mutations or a verified snapshot when online.
3. Workers authenticate the account and workspace, validate the protocol, and commit idempotently.
4. The workspace Durable Object orders accepted changes and notifies connected clients.
5. Clients download by cursor, reconcile using the shared rules, stage assets, and commit atomically.

## Privacy boundary

Only workspace records and user-owned assets sync. AI models, adapters, caches, embeddings, credentials, device preferences, temporary files, and diagnostics remain local.
