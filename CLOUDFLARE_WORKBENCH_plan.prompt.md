# Workbench Cloudflare Web App and Cross-Platform Sync

## Summary

Build a Cloudflare-hosted Workbench web application with feature parity across projects, thoughts, tasks, notes, boards/canvas, drawings, media, voice memos, Wiki, import/export, settings, and sync. The AI model remains excluded and capability-gated.

Cloudflare becomes the canonical sync service for Android, iOS, macOS, and the web client. Existing local-first storage and Workbench Sync Protocol v1 remain authoritative on native clients.

## Architecture

- Cloudflare Pages hosts the web client.
- Cloudflare Workers provides authenticated APIs and realtime sync notifications.
- D1 stores accounts, workspaces, devices, mutations, revisions, tombstones, conflicts, acknowledgements, and cursors.
- R2 stores immutable snapshots and user-owned assets with SHA-256 verification and resumable uploads.
- Durable Objects coordinate per-workspace ordering, idempotency, and notifications.
- Queues handle asset processing, compaction, retention, and recovery jobs.
- Passkeys plus Apple/Google OAuth provide identity.
- TLS and Cloudflare-managed encryption protect cloud data.

Model weights, credentials, inference caches, embeddings, training checkpoints, temporary files, and diagnostics never synchronize.

## Sync model

- Preserve stable UUIDs, entity kinds, canonical JSON, structured revisions, mutation IDs, tombstones, conflict copies, and current-plus-three-version recovery.
- Implement a server adapter around `docs/WORKBENCH_SYNC_PROTOCOL_V1.md`; do not create a separate web-only wire format.
- Keep durable client outboxes, applied receipts, cursors, retries, and offline editing.
- Validate workspace identity, protocol version, revisions, asset paths, hashes, limits, and authorization before persistence.
- Make retries idempotent and retain tombstones until trusted clients acknowledge them.
- Upload assets through resumable R2 sessions and expose them only after complete hash verification.

## Web feature scope

Implement projects, thoughts, notes, tasks, ordering, tags, boards, canvas items, drawings, media, voice memo metadata/playback, Wiki pages and sources, import/export, settings, diagnostics, devices, conflicts, sync activity, retry, pause/resume, and revoke.

AI-related screens must show explicit unavailable states rather than fake responses or model placeholders.

## Delivery phases

1. Finalize account, workspace, mutation, revision, asset, conflict, cursor, and acknowledgement contracts.
2. Implement Workers, D1, R2, Durable Objects, queues, authorization, idempotency, and observability.
3. Build the web shell, authentication, local browser persistence, offline outbox, and sync foundation.
4. Add full feature parity and conflict-aware editing.
5. Integrate Cloudflare transport into Android, iOS, and macOS while preserving provider import/export recovery paths.
6. Run physical cross-platform acceptance and enable automatic sync only after all gates pass.

## Acceptance

Test Android↔iOS, Android↔macOS, iOS↔macOS, and web↔each native client. Verify edits, simultaneous edits, conflicts, tombstones, assets, interruption/resume, account switching, revocation, large assets, offline work, and cold restart. Matching record and asset hashes are required; builds and fixtures alone do not qualify as live sync proof.

## Assumptions

- Cloudflare is the long-term canonical sync service.
- Passkeys plus Apple/Google OAuth are the initial identity mechanisms.
- Server-side encrypted storage is the default; end-to-end encryption is deferred until key recovery and browser interoperability are designed.
- Existing local-first native storage, stable IDs, provider imports, and recovery packages remain supported.
