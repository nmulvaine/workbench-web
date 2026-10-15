-- Workbench Sync Protocol v1 — D1 schema (Durable Objects + Queues coordinate ordering).
-- Applied via `wrangler d1 apply` or `wrangler migrations`.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  feature_flags TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web','android','ios','macos')),
  public_key TEXT NOT NULL,
  is_revoked INTEGER NOT NULL DEFAULT 0,
  last_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  FOREIGN KEY (id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mutations (
  sequence INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  entity_kind TEXT NOT NULL CHECK (entity_kind NOT IN ('analysis','brainstormTurn','trainingDataset','trainingExample','trainingRun','checkpoint','adapter','evaluation','hat')),
  record_id TEXT NOT NULL,
  is_tombstone INTEGER NOT NULL DEFAULT 0,
  revision_counter INTEGER NOT NULL,
  origin_device_id TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('new','idempotent','conflict')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tombstones (
  mutation_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  entity_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL,
  local_revision_counter INTEGER NOT NULL,
  remote_record_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acknowledgements (
  peer_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (peer_id, sequence)
);

CREATE TABLE IF NOT EXISTS cursors (
  workspace_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL DEFAULT 0
);
