# Development Setup

## Prerequisites

- Node.js LTS and a package manager.
- Cloudflare account with Pages, Workers, D1, R2, Durable Objects, and Queues enabled.
- Wrangler authenticated with a development account.
- Apple and Google OAuth application credentials.
- WebAuthn/passkey domain configuration.

## Initial setup

1. Copy `.env.example` to `.env.local`.
2. Install dependencies after the package manager and framework are selected.
3. Create local D1, R2, Durable Object, and Queue bindings through Wrangler.
4. Apply migrations locally.
5. Run the web client and Workers locally together.
6. Exercise offline editing and sync against local Cloudflare emulation before using a remote environment.

Never commit OAuth secrets, private keys, tokens, or production bindings.

## Validation gates

Run contract tests first, then API/storage integration tests, browser offline tests, and finally physical cross-platform convergence tests. Do not enable automatic sync based only on builds or fixtures.
