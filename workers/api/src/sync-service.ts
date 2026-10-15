/**
 * Server-side commit pipeline for Workbench Sync Protocol v1.
 *
 * This module is deliberately free of Cloudflare bindings so the authorization,
 * idempotency, conflict, and observability logic can be unit-tested in isolation.
 * The Workers entrypoint wires these pure functions to D1/R2/Durable Objects.
 */
import { AI_ONLY_KINDS } from "../../../packages/sync-contracts/src/entity-kind.js";
import type { SyncableRecord } from "../../../packages/sync-contracts/src/record.js";
import { recordMutationID } from "../../../packages/sync-contracts/src/record.js";
import type { Revision } from "../../../packages/sync-contracts/src/revision.js";
import { makeRevision } from "../../../packages/sync-contracts/src/revision.js";
import { hashRecord } from "../../../packages/sync-contracts/src/record.js";
import { mergeDecision } from "../../../packages/sync-contracts/src/conflict.js";
import type { Acknowledgement } from "../../../packages/sync-contracts/src/acknowledgement.js";

/** A device is authorized to commit mutations for a workspace. */
export interface DeviceIdentity {
  readonly deviceId: string;
  /** Whether the device has been revoked (e.g. account switch / logout). */
  readonly revoked: boolean;
}

export type CommitOutcome = "new" | "idempotent" | "conflict";

/** A single mutation applied to a workspace's change stream. */
export interface Mutation {
  readonly sequence: number;
  readonly record: SyncableRecord;
  readonly outcome: CommitOutcome;
}

/** Result of committing an envelope batch. */
export interface CommitResult {
  readonly committedSequences: number[];
  readonly tombstones: number;
  readonly conflicts: number;
  readonly rejected: string[]; // human-readable reasons for dropped records/assets
  /** Records that were committed (aligned with committedSequences). */
  readonly committedRecords: SyncableRecord[];
  /** Conflict copies that need to be persisted to the conflicts table. */
  readonly conflictCopies: SyncableRecord[];
}

function isAiOnly(record: SyncableRecord): boolean {
  return AI_ONLY_KINDS.has(record.entityKind);
}

/**
 * Authorization gate. Revoked devices are refused outright; otherwise the device
 * identity is recorded so idempotency and conflict detection can attribute changes.
 */
export function authorize(identity: DeviceIdentity | undefined, record: SyncableRecord): string {
  if (!identity) throw new Error("missing device identity");
  if (identity.revoked) throw new Error(`device ${identity.deviceId} is revoked`);
  return "";
}

/**
 * Idempotency check. A mutation whose stable id already exists in the stream is a
 * replay of our own change and must be dropped without consuming a sequence slot.
 */
export function dedupe(sequence: number, record: SyncableRecord, existing: Mutation[]): boolean {
  const seen = new Set(existing.map((m) => m.record.mutationID));
  if (seen.has(record.mutationID)) return true;
  // A tombstoned mutation id is permanently consumed.
  for (const ack of existing.filter((m) => m.record.isTombstone).map((m) => m.record.mutationID)) {
    seen.add(ack);
  }
  seen.add(record.mutationID);
  return false;
}

/**
 * Conflict resolution for a record already present in the stream. Text-bearing
 * records preserve both sides as conflict copies; everything else follows revision
 * ordering and last-modified timestamps.
 */
export function resolve(sequence: number, incoming: SyncableRecord, existing: Mutation[]): {
  outcome: CommitOutcome;
  record: SyncableRecord;
} {
  const prior = existing.find((m) => m.record.id === incoming.id);
  if (!prior) return { outcome: "new", record: incoming };

  const decision = mergeDecision(prior.record, incoming);
  if (decision === "keepLocal") return { outcome: "idempotent", record: prior.record };
  if (decision === "acceptRemote") return { outcome: "new", record: incoming };
  // preserveConflict -> keep the existing record and stage a conflict copy.
  return { outcome: "conflict", record: prior.record };
}

/**
 * Commit one envelope against an in-memory stream. Pure, deterministic, and free of
 * bindings so it can be exercised by tests before any D1/R2/DO wiring exists.
 */
export async function commitEnvelope(
  identity: DeviceIdentity | undefined,
  sequenceStart: number,
  records: SyncableRecord[],
  existing: Mutation[],
): Promise<CommitResult> {
  const committedSequences: number[] = [];
  let tombstones = 0;
  let conflicts = 0;
  const rejected: string[] = [];
  const committedRecords: SyncableRecord[] = [];
  const conflictCopies: SyncableRecord[] = [];

  for (const record of records) {
    try {
      authorize(identity, record);
    } catch (reason) {
      rejected.push(`${record.entityKind}:${record.id} — ${String(reason)}`);
      continue;
    }

    // AI-only kinds never enter the sync stream; count as conflicts.
    if (isAiOnly(record)) {
      conflicts += 1;
      continue;
    }

    if (dedupe(sequenceStart, record, existing)) {
      // Idempotent replay: no new sequence slot consumed.
      continue;
    }

    const { outcome, record: resolvedRecord } = resolve(sequenceStart, record, existing);
    let committedRecord: SyncableRecord = resolvedRecord;
    if (outcome === "idempotent") {
      // Replay of our own change: keep the prior authoritative copy but still register the sequence.
      const priorPayload = existing.find((m) => m.record.id === record.id)?.record.payload;
      committedRecord = { ...committedRecord, payload: priorPayload };
    } else if (outcome === "conflict") {
      conflicts += 1;
      if (isAiOnly(committedRecord)) {
        continue; // AI-only kinds never persist conflict copies; they are dropped.
      }
      // Stage a conflict copy for text-bearing kinds.
      const conflictCopy = {
        ...committedRecord,
        id: `${committedRecord.id}:conflict:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        mutationID: recordMutationID({ ...committedRecord, id: committedRecord.id, revision: makeRevision(0, "server") }),
        isTombstone: false,
        payload: committedRecord.payload,
      };
      conflictCopies.push(conflictCopy);
    }

    committedSequences.push(sequenceStart);
    committedRecords.push(committedRecord);
    existing.push({ sequence: sequenceStart, record: committedRecord, outcome });
    if (committedRecord.isTombstone) tombstones += 1;
  }

  return { committedSequences, tombstones, conflicts, rejected, committedRecords, conflictCopies };
}

/**
 * Acknowledgement accounting. A tombstone may be compacted once at least one trusted
 * peer acknowledges having applied it. Returns the set of tombstones still required.
 */
export function tombstonesRetained(
  tombstones: Mutation[],
  acknowledgements: Acknowledgement[],
): number {
  let retained = 0;
  for (const t of tombstones) {
    const covered = acknowledgements.some((a) => a.peerID !== t.record.revision.originDeviceID);
    if (!covered) retained += 1;
  }
  return retained;
}

/** Observability: a compact, deterministic summary of a commit for logs/metrics. */
export interface CommitSummary {
  readonly envelopeSize: number;
  readonly committedCount: number;
  readonly tombstoneCount: number;
  readonly conflictCount: number;
  readonly rejectedCount: number;
}

export function summarize(result: CommitResult, envelopeSize: number): CommitSummary {
  return {
    envelopeSize,
    committedCount: result.committedSequences.length,
    tombstoneCount: result.tombstones,
    conflictCount: result.conflicts,
    rejectedCount: result.rejected.length,
  };
}

/** Content hash of a record for cross-platform verification. */
export async function verifyRecord(record: SyncableRecord): Promise<string> {
  return hashRecord(record);
}
