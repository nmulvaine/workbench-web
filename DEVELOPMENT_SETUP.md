# Development setup

## Local app

- Use Node.js 22.19 or newer.
- Run `npm ci`, then `npm run dev` for the Astro app.
- Project and Thought records are stored in browser IndexedDB, namespaced by account and Workbench workspace ID. Each edit and its outbox entry commit in the same transaction.
- `npm run check` runs protocol/API tests, TypeScript checks, an Astro build, and the static Worker's Wrangler dry run.
- `npm run preview` previews the Astro Cloudflare Worker. It does not start the sync API.

The browser uses Cloudflare Access OIDC authorization-code with PKCE. It fetches the public Access client configuration from the sync Worker, verifies state in the browser, and exchanges the code through the Worker; only a short-lived ID token is kept in the tab's `sessionStorage`. Local records use the `local-browser` scope until enrollment succeeds. Sync is user-triggered; the outbox removes entries only after the server acknowledges their mutation IDs.

## Sync Worker status

The Workbench page is deployed at `https://workbench-web.nmulvaine.workers.dev`; the sync API is at `https://workbench-sync-api-staging.nmulvaine.workers.dev` with its D1 schema. `SYNC_ENABLED=false`, so data sync remains unavailable until the R2 bucket, Access OIDC app, and Worker settings are configured. The Web and Android clients now expose manual Access sign-in and Sync Now controls. Do not enable automatic sync until device authorization and the Android↔page acceptance matrix pass.

The native Rust envelope and immutable `CloudWorkspaceStore` package snapshot are distinct integrations. The Worker accepts protocol-v1 record envelopes and has a separate immutable snapshot API; native app adapters must be implemented and tested against the latter before claiming cross-platform sync.

## Cloudflare environments

See [Cloudflare environments](CLOUDFLARE_ENVIRONMENTS.md) for environment provisioning, migration, secrets, rollback, and recovery steps. Do not put production database IDs, tokens, or private keys in source control. Never set `SYNC_ENABLED=true` until the release gate in the native protocol document has passed.
