# Development Setup

## Prerequisites

- Node.js 22.19 or newer and npm.
- Wrangler for local Cloudflare Worker preview.
- A Cloudflare account is only needed for deployment; no production deployment is part of local setup.

## Initial setup

1. Run `npm ci`.
2. Run `npm run dev` for the Astro client.
3. Run `npm run preview` to build the Astro Worker and preview it with Wrangler.
4. Run `npm run check` before proposing a change.

The sync API under `workers/api` deliberately returns `503 sync_unavailable`; it is not connected to the Astro deployment. Its Wrangler configuration and SQL schema are drafts, not provisioned Cloudflare resources. Do not deploy the API until authentication, authorization, transactional storage, and environment bindings are implemented and reviewed.

Never commit OAuth secrets, private keys, tokens, or production bindings. Do not put production IDs or secrets in the checked-in Wrangler files.

## Validation gates

Run contract and API guard tests, type checks, Astro build, and Wrangler dry-run with `npm run check`. This proves the starter shell builds and that the sync endpoint remains disabled; it does not prove persistence or cross-platform sync. Add D1/R2 local adapter, browser outbox, and physical platform acceptance tests before enabling sync.
