# Workbench Web

Workbench Web is the Astro and Cloudflare foundation for a browser version of Workbench and its cross-platform sync service.

## Current status

The Astro client is still the upstream starter shell. The Workbench sync contracts and API are early scaffolding and are not production-ready: authentication, persistence, authorization, asset transfer, and client integration remain incomplete. Do not enable production sync or describe the deployed starter page as the Workbench application.

## Repository layout

- `src/` — Astro web application.
- `packages/sync-contracts/` — platform-neutral Workbench Sync Protocol contracts and fixtures.
- `workers/api/` — Cloudflare Worker API scaffold.
- `infra/` — sync service Wrangler configuration and D1 schema draft.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Sync protocol integration](SYNC_PROTOCOL.md)
- [Cloudflare project plan](CLOUDFLARE_WORKBENCH_plan.prompt.md)
- [Development setup](DEVELOPMENT_SETUP.md)

## Development

Use Node.js 22.19 or newer and npm:

```sh
npm ci
npm run dev
npm run check
```

`npm run check` runs the contract and API tests, TypeScript checks, Astro production build, and Wrangler dry-run. `npm run preview` builds and runs the Cloudflare Worker locally. Production deployment is intentionally a separate command (`npm run deploy`).

Never commit credentials or production binding values. See [Development setup](DEVELOPMENT_SETUP.md) before configuring Cloudflare resources.
