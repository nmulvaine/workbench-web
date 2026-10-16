# Architecture

## Current components

- `src/` — Astro browser shell.
- `packages/storage/` — browser IndexedDB records and durable mutation outbox.
- `packages/sync-contracts/` — Workbench v1 wire contracts, canonical encoding, reconciliation rules, and native fixtures.
- `workers/api/` — disabled-by-default Cloudflare sync Worker.
- `infra/migrations/0001_sync.sql` — D1 schema scoped by account and the native Workbench workspace ID.

## Current browser flow

1. Projects and Thoughts are written to IndexedDB with their outbox entry in one strict transaction.
2. Local state remains available after reload and is partitioned by account/workspace scope.
3. After the user connects with a short-lived OIDC JWT, the browser can manually push pending mutations, pull cursor pages, preserve concurrent edits, apply records locally, and acknowledge the applied cursor. The token stays in the tab's session storage. While that session is active, the page retries on local edits, reconnect, visibility, and periodic catch-up.

## Current implementation status

- The project page supports local project create, edit, and tombstone delete, then manual or session-active automatic push/pull through the v1 contract.
- The Worker implements authenticated mutation, cursor, acknowledgement, device, conflict, snapshot, and asset routes. CORS is enabled for bearer-token browser calls.
- `GET /sync/readiness` exposes only fail-closed configuration state for sync enablement, OIDC, D1, and R2; it exposes no tenant, workspace, or secret material.
- All checked-in Cloudflare environments still set `SYNC_ENABLED = false`; production D1/R2/OIDC provisioning and deployment are not complete.
- Android has a separate manual Cloudflare OIDC session and incremental record client. Refresh-token auth, Cloudflare WorkManager scheduling, and native asset transfer remain acceptance work.

## Planned server flow

1. Verify the OIDC JWT signature and required identity claims.
2. Resolve the caller's account-scoped workspace membership and active device.
3. Validate Workbench protocol records and syncable entity kinds.
4. Use a D1 batch transaction to allocate monotonic change sequences and persist idempotent mutations, tombstones, and conflict history.
5. Store immutable native workspace package snapshots and verified R2 chunks under account-scoped object keys; expose assets only after full-hash verification.
6. Return changes by cursor and record monotonic device acknowledgements.

These routes remain unavailable until configured bindings and client adapters pass acceptance. No Durable Object or queue is configured. Conflict history is durable but has no client review/resolution flow. Tombstones remain retained; pruning is intentionally not enabled until native snapshot recovery and peer acknowledgement policy are verified.

## Privacy boundary

Only native-supported workspace records and user-owned assets may sync. AI models, adapters, caches, embeddings, training data, credentials, device preferences, temporary files, and diagnostics stay local. New record kinds require matching native projections and protocol fixtures before they enter `NATIVE_SYNCABLE_KINDS`.
