import { isSyncableKind } from "../../../packages/sync-contracts/src/entity-kind.js";
import { MergeDecision, mergeDecision } from "../../../packages/sync-contracts/src/conflict.js";
import { canonicalJSON, hashRecord, recordMutationID, validateRecord } from "../../../packages/sync-contracts/src/record.js";
import type { SyncableRecord } from "../../../packages/sync-contracts/src/record.js";

export interface DurableDB extends D1Database {}
export interface Principal { readonly subject: string; readonly workspaceID: string; readonly deviceID: string }
export interface AcceptedChange { readonly sequence: number; readonly record: SyncableRecord; readonly mutationID: string; readonly hash: string }
export type StoreErrorCode = "FORBIDDEN" | "INVALID_RECORD" | "DEVICE_REVOKED" | "CONFLICT";

export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string) { super(message); }
}

/**
 * Durable D1 mutation writer. Every batch is one D1 batch transaction: cursor
 * allocation, idempotency insert, record journal, and tombstone are committed or
 * rolled back together. Conditional cursor update serializes competing writers.
 */
export async function commitRecords(db: DurableDB, principal: Principal, input: unknown[]): Promise<AcceptedChange[]> {
  if (!principal.subject || !principal.workspaceID || !principal.deviceID || input.length === 0 || input.length > 100) {
    throw new StoreError("INVALID_RECORD", "invalid batch identity or size");
  }
  const membership = await db.prepare(
    "SELECT role, account_id FROM workspace_members WHERE workspace_id = ? AND subject = ?",
  ).bind(principal.workspaceID, principal.subject).first<{ role: string; account_id: string }>();
  if (!membership || membership.role === "viewer") throw new StoreError("FORBIDDEN", "workspace is not writable");
  const accountID = membership.account_id;
  const device = await db.prepare(
    "SELECT id FROM devices WHERE workspace_id = ? AND account_id = ? AND id = ? AND subject = ? AND revoked_at IS NULL",
  ).bind(principal.workspaceID, accountID, principal.deviceID, principal.subject).first<{ id: string }>();
  if (!device) throw new StoreError("DEVICE_REVOKED", "device is unknown or revoked");

  const records = input.map((value) => {
    try { validateRecord(value); } catch (error) { throw new StoreError("INVALID_RECORD", String(error)); }
    if (!isSyncableKind(value.entityKind)) throw new StoreError("INVALID_RECORD", "record kind is not syncable");
    if (value.revision.originDeviceID !== principal.deviceID) throw new StoreError("FORBIDDEN", "record origin does not match authenticated device");
    return value;
  });
  const currentRecords = new Map<string, SyncableRecord>();
  for (const record of records) {
    const key = `${record.entityKind}\u0000${record.id}`;
    if (currentRecords.has(key)) continue;
    const current = await db.prepare(
      "SELECT record_json FROM mutations WHERE workspace_id = ? AND account_id = ? AND entity_kind = ? AND record_id = ? AND outcome = 'new' ORDER BY sequence DESC LIMIT 1",
    ).bind(principal.workspaceID, accountID, record.entityKind, record.id).first<{ record_json: string }>();
    if (current) currentRecords.set(key, JSON.parse(current.record_json) as SyncableRecord);
  }

  const existing = await db.prepare(
    records.length
      ? "SELECT sequence, mutation_id FROM mutations WHERE workspace_id = ? AND account_id = ? AND mutation_id IN (" + records.map(() => "?").join(",") + ")"
      : "SELECT sequence, mutation_id FROM mutations WHERE workspace_id = ? AND account_id = ? AND 0",
  ).bind(principal.workspaceID, accountID, ...records.map(recordMutationID)).all<{ sequence: number; mutation_id: string }>();
  const seen = new Map(existing.results.map((row) => [row.mutation_id, row.sequence]));
  const result: AcceptedChange[] = [];
  const statements: D1PreparedStatement[] = [];
  let sequence = await db.prepare("SELECT cursor FROM workspaces WHERE id = ? AND account_id = ?").bind(principal.workspaceID, accountID).first<{ cursor: number }>();
  if (!sequence) throw new StoreError("FORBIDDEN", "workspace not found");
  let cursor = sequence.cursor;
  for (const record of records) {
    const mutationID = recordMutationID(record);
    const duplicateSequence = seen.get(mutationID);
    if (duplicateSequence !== undefined) {
      result.push({ sequence: duplicateSequence, record, mutationID, hash: await hashRecord(record) });
      continue;
    }
    const next = ++cursor;
    seen.set(mutationID, next);
    const hash = await hashRecord(record);
    const recordJSON = canonicalJSON(record);
    const recordKey = `${record.entityKind}\u0000${record.id}`;
    const currentRecord = currentRecords.get(recordKey);
    const decision = currentRecord ? mergeDecision(currentRecord, record) : MergeDecision.acceptRemote;
    const outcome = decision === MergeDecision.preserveConflict ? "conflict" : decision === MergeDecision.keepLocal ? "idempotent" : "new";
    statements.push(db.prepare(
      `INSERT INTO mutations (workspace_id, account_id, sequence, mutation_id, record_id, entity_kind, is_tombstone, revision_counter, origin_device_id, modified_at, hash, record_json, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(principal.workspaceID, accountID, next, mutationID, record.id, record.entityKind, record.isTombstone ? 1 : 0, record.revision.counter, principal.deviceID, record.modifiedAt, hash, recordJSON, outcome, new Date().toISOString()));
    if (decision === MergeDecision.preserveConflict && currentRecord) {
      statements.push(db.prepare(
        "INSERT INTO conflicts (id, workspace_id, account_id, entity_kind, record_id, local_record_json, remote_record_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID().toUpperCase(), principal.workspaceID, accountID, record.entityKind, record.id, canonicalJSON(currentRecord), recordJSON, new Date().toISOString()));
    }
    if (record.isTombstone) statements.push(db.prepare(
      "INSERT OR IGNORE INTO tombstones (workspace_id, account_id, mutation_id, sequence, entity_kind, record_id, origin_device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(principal.workspaceID, accountID, mutationID, next, record.entityKind, record.id, principal.deviceID, new Date().toISOString()));
    result.push({ sequence: next, record, mutationID, hash });
    if (decision === MergeDecision.acceptRemote) currentRecords.set(recordKey, record);
  }
  if (cursor !== sequence.cursor) {
    statements.unshift(db.prepare("UPDATE workspaces SET cursor = ? WHERE id = ? AND account_id = ? AND cursor = ?").bind(cursor, principal.workspaceID, accountID, sequence.cursor));
  }
  if (statements.length) {
    let batch: D1Result[];
    try {
      batch = await db.batch(statements);
    } catch {
      // Unique mutation/cursor constraints can fail when another writer commits
      // after our reads. D1 batch is transactional, so the cursor and records
      // roll back together; the caller can retry and observe the committed ID.
      throw new StoreError("CONFLICT", "workspace changed concurrently; retry the batch");
    }
    if (batch.some((item) => item.success === false)) throw new StoreError("CONFLICT", "mutation transaction failed");
    if (cursor !== sequence.cursor) {
      const head = await db.prepare("SELECT cursor FROM workspaces WHERE id = ? AND account_id = ?").bind(principal.workspaceID, accountID).first<{ cursor: number }>();
      if (head?.cursor !== cursor) throw new StoreError("CONFLICT", "workspace cursor advanced concurrently; retry the batch");
    }
  }
  return result;
}
