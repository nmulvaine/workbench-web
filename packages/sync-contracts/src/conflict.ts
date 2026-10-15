/**
 * Conflict handling and merge decisions. For text-bearing records we preserve both
 * sides as deterministic conflict copies instead of silently overwriting, matching
 * the native SyncReconciler semantics so every platform produces identical plans.
 */
import { EntityKind, preservesConcurrentTextEdits } from "./entity-kind.js";
import { recordMutationID } from "./record.js";
import type { SyncableRecord } from "./record.js";
import { revisionGreater } from "./revision.js";
import type { Revision } from "./revision.js";

export enum MergeDecision {
  /** Accept the remote change; local is discarded. */
  acceptRemote = "acceptRemote",
  /** Keep the local change; remote is discarded. */
  keepLocal = "keepLocal",
  /** Preserve both sides as a conflict copy for supported text-bearing records. */
  preserveConflict = "preserveConflict",
}

export interface Conflict {
  readonly id: string;
  readonly entityKind: EntityKind;
  /** The local revision that conflicted with the remote change. */
  readonly localRevision: Revision;
  /** The remote record preserved alongside the conflict. */
  readonly remote: SyncableRecord;
}

export function mergeDecision(
  local: SyncableRecord | undefined,
  remote: SyncableRecord,
): MergeDecision {
  if (!local) return MergeDecision.acceptRemote;
  // Idempotent replay of our own mutation. A stable mutation id is authoritative
  // even when the payload reserializes differently or the timestamps diverge.
  if (recordMutationID(local) === recordMutationID(remote)) return MergeDecision.keepLocal;

  const localCausal = local.causalHistory ?? {};
  const remoteCausal = remote.causalHistory ?? {};

  // One side causally contains the other -> no conflict.
  if ((remoteCausal[local.revision.originDeviceID] ?? 0) >= local.revision.counter && local.revision.counter > 0) {
    return MergeDecision.acceptRemote;
  }
  if ((localCausal[remote.revision.originDeviceID] ?? 0) >= remote.revision.counter && remote.revision.counter > 0) {
    return MergeDecision.acceptRemote;
  }

  // Both sides carry causal history and differ -> conflict.
  if (Object.keys(localCausal).length > 0 || Object.keys(remoteCausal).length > 0) {
    if (local.revision.originDeviceID !== remote.revision.originDeviceID &&
        (local.payload !== remote.payload || local.isTombstone !== remote.isTombstone)) {
      return MergeDecision.preserveConflict;
    }
  }

  // Same revision, differing payload on a text-bearing kind -> conflict copy.
  if (remote.revision.counter === local.revision.counter &&
      remote.payload !== local.payload && preservesConcurrentTextEdits(remote.entityKind)) {
    return MergeDecision.preserveConflict;
  }

  // Fall back to revision ordering, then last-modified timestamp.
  if (revisionGreater(remote.revision, local.revision)) return MergeDecision.acceptRemote;
  if (revisionGreater(local.revision, remote.revision)) return MergeDecision.keepLocal;
  if (remote.payload === local.payload && remote.isTombstone === local.isTombstone) return MergeDecision.keepLocal;
  return remote.modifiedAt > local.modifiedAt ? MergeDecision.acceptRemote : MergeDecision.keepLocal;
}
