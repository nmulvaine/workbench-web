-- Cloudflare sync metadata. Apply separately to each environment after reviewed
-- identity-provider configuration. These tables are not provisioned by default.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  PRIMARY KEY (id, account_id)
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (workspace_id, account_id, subject),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
-- Current native CloudSyncCoordinator has one fixed workspace ID per provider account.
CREATE UNIQUE INDEX IF NOT EXISTS one_account_per_workspace_subject ON workspace_members(workspace_id, subject);

CREATE TABLE IF NOT EXISTS devices (
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web','android','ios','macos')),
  public_key TEXT NOT NULL,
  revoked_at TEXT,
  last_acknowledged_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_acknowledged_sequence >= 0),
  last_seen_at TEXT,
  PRIMARY KEY (workspace_id, account_id, id),
  UNIQUE (workspace_id, account_id, id, subject),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mutations (
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  mutation_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  is_tombstone INTEGER NOT NULL DEFAULT 0 CHECK (is_tombstone IN (0,1)),
  revision_counter INTEGER NOT NULL CHECK (revision_counter >= 0),
  origin_device_id TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('new','idempotent','conflict')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, account_id, sequence),
  UNIQUE (workspace_id, account_id, mutation_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id, origin_device_id) REFERENCES devices(workspace_id, account_id, id)
);
CREATE INDEX IF NOT EXISTS mutations_record ON mutations(workspace_id, account_id, entity_kind, record_id, sequence DESC);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  local_record_json TEXT NOT NULL,
  remote_record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS acknowledgements (
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, account_id, device_id),
  FOREIGN KEY (workspace_id, account_id, device_id, subject) REFERENCES devices(workspace_id, account_id, id, subject) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tombstones (
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  entity_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, account_id, mutation_id),
  FOREIGN KEY (workspace_id, account_id, sequence) REFERENCES mutations(workspace_id, account_id, sequence) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS asset_uploads (
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  manifest_json TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  media_type TEXT NOT NULL,
  logical_path TEXT NOT NULL,
  chunk_size INTEGER NOT NULL CHECK (chunk_size > 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  completed_chunks_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('uploading','verified','committed')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, account_id, asset_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_snapshots (
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, account_id, snapshot_id),
  UNIQUE (workspace_id, account_id, file_path),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

-- No state is deletable until retention policy and all trusted-peer ACKs agree.
