/**
 * Worker entrypoint for the Workbench Sync Protocol v1.
 *
 * Wires the binding-free commit pipeline (sync-service) to D1/R2 bindings
 * so the worker can authenticate, validate, commit, and persist envelopes.
 */
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { validateEnvelope } from "../../../packages/sync-contracts/src/envelope.js";
import { commitEnvelope, summarize } from "./sync-service.js";
import type { DeviceIdentity, CommitResult } from "./sync-service.js";
import type { SyncableRecord } from "../../../packages/sync-contracts/src/record.js";
import type { ChangeEnvelope } from "../../../packages/sync-contracts/src/envelope.js";

/** Worker environment bindings — provided by Wrangler at runtime. */
export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
}

/**
 * Look up device identity from D1. Returns undefined if the device is not found
 * or has no valid session. In production this would also verify JWT/passkey.
 */
async function resolveDeviceIdentity(env: Env, authorization: string): Promise<DeviceIdentity | undefined> {
  // Placeholder: in production this would verify the token and query D1.
  // For now, accept any Bearer token and return a default device identity.
  const deviceId = authorization.replace("Bearer ", "");
  return { deviceId, revoked: false };
}

/**
 * Persist committed mutations to D1.
 */
async function persistMutations(env: Env, workspaceID: string, sequences: number[], records: SyncableRecord[]): Promise<void> {
  const insert = (env.DB as any).prepare(
    `INSERT OR IGNORE INTO mutations (sequence, workspace_id, mutation_id, entity_kind, record_id, is_tombstone, revision_counter, origin_device_id, modified_at, hash, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (let i = 0; i < sequences.length; i++) {
    const seq = sequences[i];
    const record = records[i];
    if (!record) continue;
    const hash = await hashRecord(record);
    await insert.run(
      seq,
      workspaceID,
      record.mutationID,
      record.entityKind,
      record.id,
      record.isTombstone ? 1 : 0,
      record.revision.counter,
      record.revision.originDeviceID,
      record.modifiedAt,
      hash,
      "new",
    );
  }
}

/**
 * Persist conflict copies to D1.
 */
async function persistConflicts(env: Env, workspaceID: string, conflictCopies: SyncableRecord[]): Promise<void> {
  if (conflictCopies.length === 0) return;

  const insert = (env.DB as any).prepare(
    `INSERT INTO conflicts (id, entity_kind, local_revision_counter, remote_record_id, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );

  for (const copy of conflictCopies) {
    const conflictId = `${workspaceID}:${copy.id}:conflict:${Date.now()}`;
    await insert.run(
      conflictId,
      copy.entityKind,
      copy.revision.counter,
      copy.id,
      new Date().toISOString(),
    );
  }
}

/**
 * Persist tombstones to D1.
 */
async function persistTombstones(env: Env, workspaceID: string, tombstoneRecords: SyncableRecord[]): Promise<void> {
  if (tombstoneRecords.length === 0) return;

  const insert = (env.DB as any).prepare(
    `INSERT OR IGNORE INTO tombstones (mutation_id, sequence, entity_kind, record_id, origin_device_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const record of tombstoneRecords) {
    await insert.run(
      record.mutationID,
      record.revision.counter,
      record.entityKind,
      record.id,
      record.revision.originDeviceID,
      record.modifiedAt,
    );
  }
}

/**
 * Update the workspace cursor to the highest committed sequence.
 */
async function updateCursor(env: Env, workspaceID: string, highestSequence: number): Promise<void> {
  const upsert = (env.DB as any).prepare(
    `INSERT INTO cursors (workspace_id, sequence) VALUES (?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET sequence = MAX(sequence, ?)`
  );
  await upsert.run(workspaceID, highestSequence, highestSequence);
}

/**
 * Upload assets to R2 after verifying content hashes.
 */
async function persistAssets(env: Env, assets: ChangeEnvelope["assets"]): Promise<void> {
  for (const asset of assets) {
    // Placeholder: in production this would upload the verified asset to R2.
    // The logicalPath is the R2 object key; contentHash is verified after upload.
  }
}

/**
 * Worker request handler — authenticates, validates, commits, and persists.
 */
export const onRequestPost: (req: Request, env: Env, ctx: unknown) => Promise<Response> = async (req, env, ctx) => {
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const identity = await resolveDeviceIdentity(env, authorization);
  if (!identity) {
    return new Response("Unauthorized: invalid credentials", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  // Validate envelope shape and protocol version.
  try {
    validateEnvelope(body);
  } catch (error) {
    return new Response(`Invalid envelope: ${error instanceof Error ? error.message : String(error)}`, {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const envelope = body as ChangeEnvelope;

  // Load existing stream from D1 for conflict detection.
  const existingResult = await (env.DB as any).prepare(
    `SELECT sequence, mutation_id, entity_kind, record_id, is_tombstone, revision_counter, origin_device_id, modified_at, outcome
     FROM mutations WHERE workspace_id = ? ORDER BY sequence`
  ).all(envelope.workspaceID);

  const existing: Awaited<ReturnType<typeof commitEnvelope>>["committedRecords"] = [];
  if (existingResult && (existingResult as any).results) {
    for (const row of (existingResult as any).results) {
      existing.push({
        sequence: row.sequence,
        record: {
          id: row.record_id,
          entityKind: row.entity_kind,
          schemaVersion: 3,
          revision: { counter: row.revision_counter, originDeviceID: row.origin_device_id },
          mutationID: row.mutation_id,
          modifiedAt: row.modified_at,
          isTombstone: row.is_tombstone === 1,
          payload: {},
        },
        outcome: row.outcome as "new" | "idempotent" | "conflict",
      });
    }
  }

  // Run the commit pipeline.
  const result = await commitEnvelope(
    identity,
    envelope.sequenceStart,
    envelope.records,
    existing,
  );

  // Persist to D1.
  try {
    await persistMutations(env, envelope.workspaceID, result.committedSequences, result.committedRecords);
    await persistConflicts(env, envelope.workspaceID, result.conflictCopies);

    // Persist tombstones separately.
    const tombstoneRecords = result.committedRecords.filter((r) => r.isTombstone);
    if (tombstoneRecords.length > 0) {
      await persistTombstones(env, envelope.workspaceID, tombstoneRecords);
    }

    // Update cursor.
    if (result.committedSequences.length > 0) {
      const highestSeq = result.committedSequences[result.committedSequences.length - 1];
      await updateCursor(env, envelope.workspaceID, highestSeq);
    }

    await persistAssets(env, envelope.assets);
  } catch (error) {
    return new Response(`Persistence failed: ${error instanceof Error ? error.message : String(error)}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const summary = summarize(result, envelope.records.length + envelope.assets.length);
  return new Response(JSON.stringify({ status: "ok", ...summary }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
  return new Response(JSON.stringify({ status: "ok", ...summary }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
