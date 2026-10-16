# Workbench Web

Workbench Web is the Astro and Cloudflare foundation for a browser version of Workbench and its cross-platform sync service.

## Current status

The browser shell creates Projects and Thoughts in IndexedDB, keeps a durable outbox, and provides manual Cloudflare connection/sync controls. The sync API has verified OIDC token handling, account-scoped D1 mutation/cursor code, conflict history, device registration/revocation, snapshots, and resumable R2 asset routes. A disabled staging Worker and its D1 schema are deployed; R2 and OIDC settings are still pending, so `SYNC_ENABLED` remains `false`. Android's Cloudflare adapter is an initial project/record implementation and still needs full Android↔page acceptance before automatic sync is enabled. See [Development setup](DEVELOPMENT_SETUP.md) and [Cloudflare environments](CLOUDFLARE_ENVIRONMENTS.md).

## Repository layout

- `src/` — Astro web application.
- `packages/sync-contracts/` — platform-neutral Workbench Sync Protocol contracts and fixtures.
- `packages/storage/` — browser IndexedDB records and transactional durable outbox.
- `workers/api/` — Cloudflare Worker API scaffold.
- `infra/` — sync Worker configuration and account-scoped D1 migration.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Sync protocol integration](SYNC_PROTOCOL.md)
- [Cloudflare project plan](CLOUDFLARE_WORKBENCH_plan.prompt.md)
- [Cloudflare environments](CLOUDFLARE_ENVIRONMENTS.md)
- [Development setup](DEVELOPMENT_SETUP.md)

## Development

Use Node.js 22.19 or newer and npm:

```sh
npm ci
npm run dev
npm run check
```

`npm run check` runs contract/API tests, TypeScript checks, Astro production build, and Wrangler dry-run. `npm run preview` builds and runs the Astro Worker locally. The sync Worker has a separate configuration and is disabled by default. Production deployment is intentionally a separate command (`npm run deploy`).

Never commit credentials or production binding values. See [Development setup](DEVELOPMENT_SETUP.md) before configuring Cloudflare resources.
