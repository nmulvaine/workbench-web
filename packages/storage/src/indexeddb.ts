import { WORKBENCH_WORKSPACE_ID } from "../../sync-contracts/src/envelope.js";
import { canonicalJSON, recordMutationID, validateRecord } from "../../sync-contracts/src/record.js";
import type { SyncableRecord } from "../../sync-contracts/src/record.js";
import { isSyncableKind } from "../../sync-contracts/src/entity-kind.js";
import { MergeDecision, mergeDecision } from "../../sync-contracts/src/conflict.js";

const DATABASE_NAME = "workbench-local-v1";
const DATABASE_VERSION = 2;

export interface WorkspaceScope { readonly accountID: string; readonly workspaceID: string }
export interface WorkspaceRecordPayload {
  readonly parentID: string | null;
  readonly relatedID: string | null;
  readonly strings: Readonly<Record<string, string>>;
  readonly optionalStrings: Readonly<Record<string, string>>;
  readonly stringArrays: Readonly<Record<string, readonly string[]>>;
  readonly uuidArrays: Readonly<Record<string, readonly string[]>>;
  readonly bools: Readonly<Record<string, boolean>>;
  readonly ints: Readonly<Record<string, number>>;
  readonly doubles: Readonly<Record<string, number>>;
  readonly dates: Readonly<Record<string, string>>;
  readonly data: Readonly<Record<string, string>>;
}
export interface OutboxEntry { readonly key: string; readonly scopeKey: string; readonly mutationID: string; readonly record: SyncableRecord; readonly createdAt: string }
export interface ReplayResponse { readonly acceptedMutationIDs: string[] }
export type OutboxSender = (scope: WorkspaceScope, records: SyncableRecord[]) => Promise<ReplayResponse>;

interface StoredRecord { readonly key: string; readonly scopeKey: string; readonly entityKind: string; readonly record: SyncableRecord; readonly updatedAt: string }
interface Meta { key: string; value: string | number }

export function scopeKey(scope: WorkspaceScope): string {
  if (!scope.accountID || scope.workspaceID !== WORKBENCH_WORKSPACE_ID) throw new TypeError("unsupported workspace scope");
  return `${scope.accountID}\u0000${scope.workspaceID}`;
}

/** Stable browser installation ID used as the protocol revision origin. */
export async function getInstallationDeviceID(): Promise<string> {
  const db = await openWorkbenchDatabase();
  try {
    const tx = db.transaction("metadata", "readwrite", { durability: "strict" });
    const store = tx.objectStore("metadata");
    const request = store.get("installation-device-id") as IDBRequest<Meta | undefined>;
    let deviceID = "";
    request.onsuccess = () => {
      deviceID = typeof request.result?.value === "string" ? String(request.result.value) : crypto.randomUUID().toUpperCase();
      store.put({ key: "installation-device-id", value: deviceID } satisfies Meta);
    };
    await transactionDone(tx);
    return deviceID;
  } finally { db.close(); }
}

/** Re-scope first-run local records and their outbox to the authenticated account without rewriting IDs. */
export async function moveLocalScope(from: WorkspaceScope, to: WorkspaceScope): Promise<void> {
  const fromKey = scopeKey(from); const toKey = scopeKey(to);
  if (fromKey === toKey) return;
  const db = await openWorkbenchDatabase();
  try {
    const tx = db.transaction(["records", "outbox", "metadata", "conflicts"], "readwrite", { durability: "strict" });
    const stores = ["records", "outbox", "conflicts"] as const;
    for (const name of stores) {
      const store = tx.objectStore(name);
      const request = store.index("scope").getAll(fromKey) as IDBRequest<Array<Record<string, unknown> & { key: string }>>;
      request.onsuccess = () => {
        for (const value of request.result) {
          const replacement = { ...value, key: `${toKey}${value.key.slice(fromKey.length)}`, scopeKey: toKey };
          store.put(replacement);
          store.delete(value.key);
        }
      };
    }
    const metadata = tx.objectStore("metadata");
    const metadataRequest = metadata.getAll() as IDBRequest<Meta[]>;
    metadataRequest.onsuccess = () => {
      for (const value of metadataRequest.result) {
        if (value.key === `revision-counter:${fromKey}` || value.key.startsWith(`cursor:${fromKey}:`)) {
          metadata.put({ ...value, key: value.key.replace(fromKey, toKey) }); metadata.delete(value.key);
        }
      }
    };
    await transactionDone(tx);
  } finally { db.close(); }
}

export function openWorkbenchDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("records")) {
        const records = db.createObjectStore("records", { keyPath: "key" });
        records.createIndex("scope", "scopeKey", { unique: false });
      }
      if (!db.objectStoreNames.contains("outbox")) {
        const outbox = db.createObjectStore("outbox", { keyPath: "key" });
        outbox.createIndex("scope", "scopeKey", { unique: false });
      }
      if (!db.objectStoreNames.contains("metadata")) db.createObjectStore("metadata", { keyPath: "key" });
      if (!db.objectStoreNames.contains("conflicts")) {
        const conflicts = db.createObjectStore("conflicts", { keyPath: "key" });
        conflicts.createIndex("scope", "scopeKey", { unique: false });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open local Workbench storage"));
    request.onsuccess = () => resolve(request.result);
  });
}

/** Persist a local edit and its retryable sync intent in one IndexedDB transaction. */
export async function saveLocalRecord(scope: WorkspaceScope, entityKind: string, body: unknown, id = crypto.randomUUID(), tombstone = false): Promise<SyncableRecord> {
  const key = scopeKey(scope);
  if (!isSyncableKind(entityKind)) throw new TypeError("record kind is not allowed to sync");
  const payloadObject = normalizePayload(body);
  const db = await openWorkbenchDatabase();
  try {
    const tx = db.transaction(["records", "outbox", "metadata"], "readwrite", { durability: "strict" });
    const records = tx.objectStore("records");
    const outbox = tx.objectStore("outbox");
    const metadata = tx.objectStore("metadata");
    const recordKey = `${key}\u0000${entityKind}\u0000${id}`;
    let result: SyncableRecord | undefined;
    const deviceRequest = metadata.get("installation-device-id");
    deviceRequest.onsuccess = () => {
      const deviceID = typeof deviceRequest.result?.value === "string" ? String(deviceRequest.result.value) : crypto.randomUUID().toUpperCase();
      metadata.put({ key: "installation-device-id", value: deviceID } satisfies Meta);
      const counterKey = `revision-counter:${key}`;
      const counterRequest = metadata.get(counterKey);
      counterRequest.onsuccess = () => {
        const counter = Number(counterRequest.result?.value ?? 0) + 1;
        metadata.put({ key: counterKey, value: counter } satisfies Meta);
        const oldRequest = records.get(recordKey);
        oldRequest.onsuccess = () => {
          const previous = oldRequest.result?.record as SyncableRecord | undefined;
          const causalHistory = { ...(previous?.causalHistory ?? {}) };
          if (previous) causalHistory[previous.revision.originDeviceID] = Math.max(causalHistory[previous.revision.originDeviceID] ?? 0, previous.revision.counter);
          const record: SyncableRecord = {
            ...(previous ?? {}),
            id,
            entityKind,
            schemaVersion: previous?.schemaVersion ?? 1,
            revision: { counter, originDeviceID: deviceID },
            modifiedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            isTombstone: tombstone,
            payload: encodePayload(payloadObject),
            causalHistory,
          };
          validateRecord(record);
          const mutationID = recordMutationID(record);
          const createdAt = new Date().toISOString();
          records.put({ key: recordKey, scopeKey: key, entityKind, record, updatedAt: createdAt } satisfies StoredRecord);
          outbox.put({ key: `${key}\u0000${mutationID}`, scopeKey: key, mutationID, record, createdAt } satisfies OutboxEntry);
          result = record;
        };
      };
    };
    await transactionDone(tx);
    if (!result) throw new Error("Local record transaction completed without a result");
    return result;
  } finally { db.close(); }
}

export async function listLocalRecords(scope: WorkspaceScope, entityKind?: string): Promise<SyncableRecord[]> {
  const db = await openWorkbenchDatabase();
  try {
    const tx = db.transaction("records", "readonly");
    const request = tx.objectStore("records").index("scope").getAll(scopeKey(scope)) as IDBRequest<StoredRecord[]>;
    const values = await requestValue(request);
    await transactionDone(tx);
    return values.filter((item) => !entityKind || item.entityKind === entityKind).map((item) => item.record).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } finally { db.close(); }
}

export async function listOutbox(scope: WorkspaceScope, limit = 100): Promise<OutboxEntry[]> {
  const db = await openWorkbenchDatabase();
  try {
    const tx = db.transaction("outbox", "readonly");
    const request = tx.objectStore("outbox").index("scope").getAll(scopeKey(scope)) as IDBRequest<OutboxEntry[]>;
    const values = await requestValue(request);
    await transactionDone(tx);
    return values.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, Math.max(1, Math.min(limit, 500)));
  } finally { db.close(); }
}

/** Remove only server-confirmed mutations. Failures and partial responses remain queued. */
export async function replayOutbox(scope: WorkspaceScope, send: OutboxSender, batchSize = 50): Promise<number> {
  const key = scopeKey(scope);
  let acknowledged = 0;
  while (true) {
    const batch = await listOutbox(scope, batchSize);
    if (batch.length === 0) return acknowledged;
    const response = await send(scope, batch.map((entry) => entry.record));
    const accepted = new Set(response.acceptedMutationIDs);
    const confirmed = batch.filter((entry) => accepted.has(entry.mutationID)).length;
    if (confirmed === 0) return acknowledged;
    const db = await openWorkbenchDatabase();
    try {
      const tx = db.transaction("outbox", "readwrite", { durability: "strict" });
      const store = tx.objectStore("outbox");
      for (const entry of batch) if (accepted.has(entry.mutationID)) store.delete(entry.key);
      await transactionDone(tx);
    } finally { db.close(); }
    acknowledged += confirmed;
    if (confirmed < batch.length) return acknowledged;
  }
}

export interface RemoteChange { readonly sequence: number; readonly record: SyncableRecord; readonly outcome: string }

/** Atomically applies a pulled page, preserving concurrent edits and acks locally only after writes. */
export async function applyRemoteChanges(scope: WorkspaceScope, changes: RemoteChange[]): Promise<number> {
  const key = scopeKey(scope);
  for (const change of changes) {
    if (!Number.isSafeInteger(change.sequence) || change.sequence < 1) throw new TypeError("invalid server sequence");
    validateRecord(change.record);
    if (!isSyncableKind(change.record.entityKind)) throw new TypeError("server returned a non-syncable record");
  }
  const db = await openWorkbenchDatabase();
  try {
    const tx = db.transaction(["records", "conflicts"], "readwrite", { durability: "strict" });
    const records = tx.objectStore("records");
    const conflicts = tx.objectStore("conflicts");
    for (const change of changes) {
      const remote = change.record;
      const recordKey = `${key}\u0000${remote.entityKind}\u0000${remote.id}`;
      const request = records.get(recordKey) as IDBRequest<StoredRecord | undefined>;
      request.onsuccess = () => {
        const local = request.result?.record;
        const decision = mergeDecision(local, remote);
        if (decision === MergeDecision.preserveConflict && local) {
          const conflictKey = `${key}\u0000${remote.entityKind}\u0000${remote.id}\u0000${recordMutationID(remote)}`;
          conflicts.put({ key: conflictKey, scopeKey: key, entityKind: remote.entityKind, entityID: remote.id, local, remote, sequence: change.sequence, createdAt: new Date().toISOString() });
        } else if (decision === MergeDecision.acceptRemote) {
          if (remote.isTombstone) records.delete(recordKey);
          else records.put({ key: recordKey, scopeKey: key, entityKind: remote.entityKind, record: remote, updatedAt: remote.modifiedAt } satisfies StoredRecord);
        }
      };
    }
    await transactionDone(tx);
    return changes.at(-1)?.sequence ?? 0;
  } finally { db.close(); }
}

export async function listLocalConflicts(scope: WorkspaceScope): Promise<Array<{ entityKind: string; entityID: string; local: SyncableRecord; remote: SyncableRecord; sequence: number }>> {
  const db = await openWorkbenchDatabase();
  try {
    const tx = db.transaction("conflicts", "readonly");
    const values = await requestValue(tx.objectStore("conflicts").index("scope").getAll(scopeKey(scope)) as IDBRequest<Array<{ entityKind: string; entityID: string; local: SyncableRecord; remote: SyncableRecord; sequence: number }>>);
    await transactionDone(tx);
    return values;
  } finally { db.close(); }
}

export function encodePayload(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function decodePayload(value: string): WorkspaceRecordPayload {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return normalizePayload(body);
}

function normalizePayload(value: unknown): WorkspaceRecordPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("record payload must be a typed object");
  const input = value as Record<string, unknown>;
  const maps: Record<string, "string" | "boolean" | "number" | "string[]"> = {
    strings: "string", optionalStrings: "string", bools: "boolean", ints: "number", doubles: "number", dates: "string", data: "string", stringArrays: "string[]", uuidArrays: "string[]",
  };
  const normalized: Record<string, unknown> = { parentID: input.parentID ?? null, relatedID: input.relatedID ?? null };
  for (const [key, type] of Object.entries(maps)) {
    const map = input[key] ?? {};
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new TypeError(`payload ${key} must be an object`);
    const valueMap = map as Record<string, unknown>;
    for (const [field, item] of Object.entries(valueMap)) {
      if (type === "string[]") {
        if (!Array.isArray(item) || item.some((part) => typeof part !== "string")) throw new TypeError(`payload ${key}.${field} must be a string array`);
        if (key === "uuidArrays" && (item as string[]).some((part) => !isUUID(part))) throw new TypeError(`payload ${key}.${field} contains an invalid UUID`);
      } else if (type === "number") {
        if (typeof item !== "number" || !Number.isFinite(item) || (key === "ints" && !Number.isSafeInteger(item))) throw new TypeError(`payload ${key}.${field} must be a finite ${key === "ints" ? "integer" : "number"}`);
      } else if (type === "boolean" ? typeof item !== "boolean" : typeof item !== "string") {
        throw new TypeError(`payload ${key}.${field} has an invalid value`);
      }
      if (key === "dates" && (!String(item).endsWith("Z") || Number.isNaN(Date.parse(String(item))))) throw new TypeError(`payload dates.${field} must be an ISO UTC date`);
      if (key === "data" && !isBase64(String(item))) throw new TypeError(`payload data.${field} must be base64`);
    }
    normalized[key] = valueMap;
  }
  for (const key of ["parentID", "relatedID"]) {
    if (normalized[key] !== null && (typeof normalized[key] !== "string" || !isUUID(normalized[key] as string))) throw new TypeError(`payload ${key} must be a UUID or null`);
  }
  return JSON.parse(canonicalJSON(normalized)) as WorkspaceRecordPayload;
}

function isUUID(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function isBase64(value: string): boolean {
  try { return btoa(atob(value)) === value; } catch { return false; }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}
