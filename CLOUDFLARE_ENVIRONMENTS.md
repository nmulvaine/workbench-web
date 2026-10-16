# Cloudflare environments

The sync Worker has separate `local`, `staging`, and `production` names in `infra/wrangler.toml`. All keep `SYNC_ENABLED=false` until the end-to-end gate passes. Staging has been initialized in the connected Cloudflare account: its D1 database has migration `0001_sync.sql`, and `workbench-sync-api-staging` is deployed on `workers.dev`. The account does not have R2 enabled yet, and no OIDC issuer/audience/JWKS configuration has been supplied. The private `infra/wrangler.private.toml` contains the staging D1 ID and is ignored by Git. The Astro app Worker remains configured separately in the root `wrangler.json`.

## Provisioning

1. Enable R2 in the Cloudflare account, then create the staging bucket `workbench-sync-staging`. Add its `ASSETS` binding to the ignored private config. Create separate local and production resources only when those environments are needed.
2. Keep a D1 binding named `DB` and an R2 binding named `ASSETS` in staging. Keep `SYNC_ENABLED=false` in configuration.
3. Staging D1 is already provisioned and migrated. For a new environment, apply the account-scoped schema. For example:

   ```sh
   npx wrangler d1 execute workbench-sync-staging --config infra/wrangler.private.toml --env staging --remote --file infra/migrations/0001_sync.sql
   ```

4. In Zero Trust, configure the identity source, create a Cloudflare Access OIDC SaaS application, enable PKCE, and add both redirect URIs: `https://workbench-web.nmulvaine.workers.dev/` and `com.workbench.app://oauth2redirect`. Add an Allow policy for the intended users; Access applications deny by default. The Web and Android clients use the Access authorization-code flow, while the Worker exchanges codes and keeps the OIDC client secret server-side.
5. Configure staging `AUTH_ISSUER`, `AUTH_AUDIENCE` (the Access OIDC client ID), `AUTH_JWKS_URL`, `AUTH_CLIENT_ID`, `AUTH_AUTHORIZATION_URL`, `AUTH_TOKEN_URL`, and `AUTH_REDIRECT_URIS` from the Access OIDC application. Store only `AUTH_CLIENT_SECRET` with `wrangler secret put --config infra/wrangler.private.toml --env staging AUTH_CLIENT_SECRET`; never put it in `vars` or source control.
6. Run the API dry-run, then test identity, membership, device, D1/R2 isolation, and recovery acceptance with `SYNC_ENABLED=false`. Production should have no public route until release acceptance is signed off.

The API does not currently provide a safe owner invite flow for sharing one account workspace with other identity subjects.

## Current limits and migration safety

- Record envelope bodies are capped at 1 MiB by default (maximum 8 MiB).
- Snapshot and completed asset uploads are capped at 64 MiB while the Worker uses bounded in-memory SHA-256 verification. Larger native packages need a streaming hash and multipart R2 implementation before they can sync.
- Asset chunks resume from D1 checkpoints and verify each supplied chunk hash plus the full asset hash. The record-envelope endpoint rejects attached manifests until record-to-asset commit integration is complete.
- Keep migration changes additive. Back up D1 and R2 before schema or retention changes. Do not prune tombstones or conflict history until the recovery/snapshot policy is implemented.

## Deploy and rollback

The Astro site is deployed independently with `npm run deploy`; staging is at `https://workbench-web.nmulvaine.workers.dev`. The staging sync Worker dry-run command is `npx wrangler deploy --config infra/wrangler.private.toml --env staging --dry-run`. Deploy it with the same config after bindings, identity, and schema are verified. The current staging Worker is deployed with D1 bound, no R2 binding, a CORS allowlist for the staging page, and `SYNC_ENABLED=false`.

For rollback, disable the Worker route or deploy the previous Worker version with sync disabled. Preserve D1 and R2 state while rolling back application code. Restore data only from verified backups, then check workspace/account row counts, cursor monotonicity, snapshot hashes, and asset hashes before reopening a route.

## Staging readiness check

Before treating staging as available, query `GET /sync/readiness` from the deployed sync Worker. It returns only four non-sensitive configuration states: `sync`, `identity`, `database`, and `assets`. A `200` response with `ready: true` is required before browser or Android clients can rely on automatic catch-up; any `503` response is an intentional fail-closed state and must be corrected through bindings or Worker secrets, not client retries.

Reconcile this endpoint with the deployed Worker before each release. The checked-in `SYNC_ENABLED=false` is a safe default, not evidence of the active Cloudflare account configuration. Keep the deployed CORS allowlist limited to `https://workbench-web.nmulvaine.workers.dev`; do not use a wildcard origin.

## Enabling sync

Do not set `SYNC_ENABLED=true` based on CI or fixtures. It requires verified OIDC configuration, proof-bound device credentials, account/workspace/device authorization, native Cloudflare package adapters, streaming large-file recovery, conflict resolution, tombstone retention, and the physical cross-platform release matrix in `docs/WORKBENCH_SYNC_PROTOCOL_V1.md`.
