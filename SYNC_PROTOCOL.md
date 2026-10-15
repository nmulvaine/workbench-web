# Sync Protocol Integration

The web service must interoperate with Workbench Sync Protocol v1 and the existing Rust sync core.

Required invariants:

- Stable UUIDs and workspace identity.
- Canonical sorted JSON and preserved unknown fields.
- Structured revisions `(counter, originDeviceID)`.
- Idempotent mutation IDs.
- Tombstones and acknowledgement-based pruning.
- Current record plus three prior versions.
- Deterministic conflict copies for supported text-bearing records.
- Normalized asset paths, byte counts, SHA-256 hashes, bounded chunks, and resumable checkpoints.
- Transactional record and asset application.

The first implementation should import shared fixtures from the existing Android/Rust contract rather than redefining them in the web project.
