import { AI_ONLY_KINDS, EntityKind } from "./entity-kind.js";
import type { Revision } from "./revision.js";

/**
 * Workbench Sync Protocol v1 record as encoded by workbench-sync-core.
 * `payload` is the base64 encoded platform-neutral entity body. Unknown keys are
 * retained because the native Rust representation flattens them into `unknown`.
 * Mutation IDs are derived metadata and are intentionally not serialized.
 */
export interface SyncableRecord {
  readonly id: string;
  readonly entityKind: string;
  readonly schemaVersion: number;
  readonly revision: Revision;
  readonly modifiedAt: string;
  readonly isTombstone: boolean;
  readonly payload: string;
  readonly causalHistory?: Record<string, number>;
  readonly [unknownField: string]: unknown;
}

/** Matches SyncRecord::mutation_id() including canonical UUID spelling. */
export function recordMutationID(record: Pick<SyncableRecord, "entityKind" | "id" | "revision">): string {
  return `${record.entityKind}:${canonicalUUID(record.id)}:${record.revision.counter}:${canonicalUUID(record.revision.originDeviceID)}`;
}

function canonicalUUID(value: string): string {
  const match = value.match(/^\{?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\}?$/i);
  return match ? `${match[1]}-${match[2]}-${match[3]}-${match[4]}-${match[5]}`.toUpperCase() : value;
}

/**
 * Rust's canonical JSON sorts object keys lexically, serializes compactly, then
 * escapes forward slashes. Serialize objects manually so JS's special numeric
 * property ordering cannot change the byte sequence.
 */
export function canonicalJSON(value: unknown): string {
  const encode = (current: unknown): string => {
    if (current === null || typeof current !== "object") {
      const encoded = JSON.stringify(current);
      if (encoded === undefined) throw new TypeError("value is not JSON serializable");
      return encoded;
    }
    if (Array.isArray(current)) return `[${current.map(encode).join(",")}]`;

    const object = current as Record<string, unknown>;
    const keys = Object.keys(object).sort(compareUnicodeScalars);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(object[key])}`).join(",")}}`;
  };
  return encode(value).replace(/\//g, "\\/");
}

function compareUnicodeScalars(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/** SHA-256 hex digest of canonical UTF-8 text. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  return sha256BytesHex(data);
}

/** SHA-256 hex digest of exact binary bytes. */
export async function sha256BytesHex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(data).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hash the exact canonical protocol record bytes. */
export async function hashRecord(record: SyncableRecord): Promise<string> {
  return sha256Hex(canonicalJSON(record));
}

/** Hash a record while retaining all causal and extension fields. */
export async function hashRecordWithHistory(record: SyncableRecord): Promise<string> {
  return hashRecord(record);
}

/** Structural validation compatible with the native serde representation. */
export function validateRecord(record: unknown): asserts record is SyncableRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("record must be an object");
  const value = record as Record<string, unknown>;
  for (const key of ["id", "entityKind", "revision", "modifiedAt", "payload"]) {
    if (!(key in value)) throw new TypeError(`record missing field "${key}"`);
  }
  if (typeof value.id !== "string" || !value.id) throw new TypeError("invalid record id");
  if (typeof value.entityKind !== "string" || !value.entityKind) throw new TypeError("invalid entityKind");
  if (value.schemaVersion !== undefined && (!Number.isInteger(value.schemaVersion) || Number(value.schemaVersion) < 1)) {
    throw new TypeError("invalid schemaVersion");
  }
  const revision = value.revision as Record<string, unknown>;
  if (!revision || typeof revision !== "object" || !Number.isSafeInteger(revision.counter) || Number(revision.counter) < 0 || typeof revision.originDeviceID !== "string") {
    throw new TypeError("invalid revision");
  }
  if (typeof value.modifiedAt !== "string" || !value.modifiedAt) throw new TypeError("invalid modifiedAt");
  if (value.isTombstone !== undefined && typeof value.isTombstone !== "boolean") throw new TypeError("invalid isTombstone");
  if (typeof value.payload !== "string") throw new TypeError("payload must be a base64 string");
}

/** Known AI-only kinds are held back by product policy, not the open wire enum. */
export function isAIOnlyKind(kind: string): boolean {
  return AI_ONLY_KINDS.has(kind as EntityKind);
}
