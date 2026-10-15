/**
 * The synced record is the unit of change. It carries a stable UUID, an entity
 * kind, a structured revision, a canonical-JSON payload, tombstone state, causal
 * history, and an idempotent mutation id. Every platform derives identical hashes
 * from these fields so the server can detect tampering and deduplicate retries.
 */
import { EntityKind } from "./entity-kind.js";
import type { Revision } from "./revision.js";

export interface SyncableRecord {
  readonly id: string;
  readonly entityKind: EntityKind;
  readonly schemaVersion: number;
  readonly revision: Revision;
  /** Stable mutation identifier used to deduplicate retries and idempotent replays. */
  readonly mutationID: string;
  /** ISO-8601 timestamp of the last modification. */
  readonly modifiedAt: string;
  readonly isTombstone: boolean;
  /** Canonical-JSON payload (unknown fields preserved). Empty for tombstones. */
  readonly payload: unknown;
  /** Causal history keyed by origin device id -> counter, used for conflict detection. */
  readonly causalHistory?: Record<string, number>;
}

/** Idempotent identifier for a mutation. Same value across retries and platforms. */
export function recordMutationID(record: Pick<SyncableRecord, "entityKind" | "id" | "revision">): string {
  return `${record.entityKind}:${record.id}:${record.revision.counter}:${record.revision.originDeviceID}`;
}

/**
 * Deterministic, key-sorted JSON serialization used for hashing and interop.
 * Unknown fields are preserved (sorted) so no data is lost across platforms.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalSort(value));
}

function canonicalSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSort);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalSort((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex digest of a UTF-8 string. Uses the ambient Web Crypto / Node crypto. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Content-addressed hash of a record's canonical representation. */
export async function hashRecord(record: SyncableRecord): Promise<string> {
  const body = JSON.stringify({
    id: record.id,
    mutationID: recordMutationID(record),
    entityKind: record.entityKind,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    modifiedAt: record.modifiedAt,
    isTombstone: record.isTombstone,
    payload: canonicalJSON(record.payload),
  });
  return sha256Hex(body);
}

/** Content-addressed hash of a record including its causal history. */
export async function hashRecordWithHistory(record: SyncableRecord): Promise<string> {
  const body = JSON.stringify({ ...record, causalHistory: canonicalJSON(record.causalHistory ?? {}) });
  return sha256Hex(body);
}

/** Basic structural validation of a received record. Throws on violation. */
export function validateRecord(record: unknown): asserts record is SyncableRecord {
  if (!record || typeof record !== "object") throw new TypeError("record must be an object");
  const r = record as Record<string, unknown>;
  for (const key of ["id", "entityKind", "schemaVersion", "revision", "mutationID", "modifiedAt", "isTombstone", "payload"]) {
    if (!(key in r)) throw new TypeError(`record missing field "${key}"`);
  }
  if (!r.id || typeof r.id !== "string") throw new TypeError("invalid record id");
  if (typeof r.entityKind !== "string" || !Object.values(EntityKind).includes(r.entityKind as EntityKind)) {
    throw new TypeError(`invalid entityKind "${String(r.entityKind)}"`);
  }
  const schemaVersion = Number(r.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new TypeError("invalid schemaVersion");
  const revision = r.revision as Record<string, unknown>;
  if (typeof revision !== "object" || !revision.counter || typeof revision.originDeviceID !== "string") {
    throw new TypeError("invalid revision");
  }
  if (typeof r.mutationID !== "string" || r.mutationID.length === 0) throw new TypeError("invalid mutationID");
  if (r.mutationID !== recordMutationID(r as Pick<SyncableRecord, "entityKind" | "id" | "revision">)) {
    throw new TypeError("mutationID does not match record identity");
  }
  if (!r.modifiedAt || typeof r.modifiedAt !== "string") throw new TypeError("invalid modifiedAt");
  if (typeof r.isTombstone !== "boolean") throw new TypeError("invalid isTombstone");
}
