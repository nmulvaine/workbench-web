import { WORKBENCH_WORKSPACE_ID } from "../../sync-contracts/src/envelope.js";
import { CURRENT_PROTOCOL_VERSION } from "../../sync-contracts/src/entity-kind.js";
import type { ChangeEnvelope } from "../../sync-contracts/src/envelope.js";
import { recordMutationID, validateRecord } from "../../sync-contracts/src/record.js";
import type { SyncableRecord } from "../../sync-contracts/src/record.js";
import { applyRemoteChanges, loadChangeCursor, replayOutbox, saveChangeCursor } from "./indexeddb.js";
import type { ReplayResponse, WorkspaceScope } from "./indexeddb.js";

export function makeChangeEnvelope(records: SyncableRecord[]): ChangeEnvelope {
  if (!records.length) throw new TypeError("cannot send an empty mutation batch");
  const deviceID = records[0].revision.originDeviceID;
  if (records.some((record) => record.revision.originDeviceID !== deviceID)) throw new TypeError("a batch must contain records from one device");
  const counters = records.map((record) => record.revision.counter);
  return {
    id: crypto.randomUUID().toUpperCase(),
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    workspaceID: WORKBENCH_WORKSPACE_ID,
    senderDeviceID: deviceID,
    sequenceStart: Math.min(...counters),
    sequenceEnd: Math.max(...counters),
    records,
    assets: [],
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

/** Send a queued batch with a short-lived caller-supplied identity token. */
export async function sendRecords(
  endpoint: string | URL,
  accessToken: string,
  scope: WorkspaceScope,
  records: SyncableRecord[],
  fetcher: typeof fetch = fetch,
): Promise<ReplayResponse> {
  if (!accessToken.trim()) throw new TypeError("a verified sign-in token is required");
  if (scope.workspaceID !== WORKBENCH_WORKSPACE_ID) throw new TypeError("unsupported workspace");
  const envelope = makeChangeEnvelope(records);
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Workbench-Device-ID": envelope.senderDeviceID,
    },
    body: JSON.stringify(envelope),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Sync request failed with HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !Array.isArray((result as { accepted?: unknown }).accepted)) {
    throw new Error("Sync service returned an invalid acknowledgement");
  }
  const acceptedMutationIDs = ((result as { accepted: unknown[] }).accepted).flatMap((item) => {
    if (!item || typeof item !== "object" || typeof (item as { mutationID?: unknown }).mutationID !== "string") return [];
    return [(item as { mutationID: string }).mutationID];
  });
  const sentIDs = new Set(records.map(recordMutationID));
  if (acceptedMutationIDs.some((id) => !sentIDs.has(id))) throw new Error("Sync service acknowledged an unknown mutation");
  return { acceptedMutationIDs };
}

export interface PulledChange {
  readonly sequence: number;
  readonly record: SyncableRecord;
  readonly outcome: string;
}

/** Read one bounded page of changes after the caller's durable cursor. */
export async function pullChanges(
  endpoint: string | URL,
  accessToken: string,
  scope: WorkspaceScope,
  deviceID: string,
  after: number,
  limit = 100,
  fetcher: typeof fetch = fetch,
): Promise<{ changes: PulledChange[]; nextCursor: number; hasMore: boolean }> {
  if (!accessToken.trim() || !deviceID.trim()) throw new TypeError("a verified sign-in and enrolled device are required");
  if (!Number.isSafeInteger(after) || after < 0) throw new TypeError("cursor must be a non-negative integer");
  if (scope.workspaceID !== WORKBENCH_WORKSPACE_ID) throw new TypeError("unsupported workspace");
  const url = new URL(`/sync/workspaces/${encodeURIComponent(scope.workspaceID)}/mutations`, endpoint);
  url.searchParams.set("after", String(after));
  url.searchParams.set("limit", String(Math.min(500, Math.max(1, limit))));
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Workbench-Device-ID": deviceID },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Sync request failed with HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object") throw new Error("Sync service returned an invalid change page");
  const page = result as { workspaceID?: unknown; changes?: unknown; nextCursor?: unknown; hasMore?: unknown };
  if (page.workspaceID !== scope.workspaceID || !Array.isArray(page.changes) || !Number.isSafeInteger(page.nextCursor) || typeof page.hasMore !== "boolean") {
    throw new Error("Sync service returned an invalid change page");
  }
  const changes: PulledChange[] = [];
  for (const item of page.changes) {
    if (!item || typeof item !== "object") throw new Error("Sync service returned malformed records");
    const value = item as { sequence?: unknown; record?: unknown; outcome?: unknown };
    try { validateRecord(value.record); }
    catch (error) { throw new Error(`Sync service returned malformed record: ${String(error)}`); }
    if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) <= after || typeof value.outcome !== "string") throw new Error("Sync service returned malformed change metadata");
    changes.push({ sequence: Number(value.sequence), record: value.record, outcome: value.outcome });
  }
  return { changes, nextCursor: Number(page.nextCursor), hasMore: page.hasMore };
}

/** Persist a cursor only after the caller has transactionally applied its page. */
export async function saveChangeCursor(scope: WorkspaceScope, deviceID: string, sequence: number): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("cursor must be a non-negative integer");
  const db = await openWorkbenchDatabase();
  try {
    const tx = db.transaction("metadata", "readwrite", { durability: "strict" });
    tx.objectStore("metadata").put({ key: `cursor:${scopeKey(scope)}:${deviceID}`, value: sequence } satisfies Meta);
    await transactionDone(tx);
  } finally { db.close(); }
}

export async function loadChangeCursor(scope: WorkspaceScope, deviceID: string): Promise<number> {
  const db = await openWorkbenchDatabase();
  try {
    const tx = db.transaction("metadata", "readonly");
    const value = await requestValue(tx.objectStore("metadata").get(`cursor:${scopeKey(scope)}:${deviceID}`) as IDBRequest<Meta | undefined>);
    await transactionDone(tx);
    return Number(value?.value ?? 0);
  } finally { db.close(); }
}

export async function acknowledgeCursor(endpoint: string | URL, accessToken: string, scope: WorkspaceScope, deviceID: string, sequence: number, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(new URL(`/sync/workspaces/${encodeURIComponent(scope.workspaceID)}/acknowledgements`, endpoint), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "X-Workbench-Device-ID": deviceID },
    body: JSON.stringify({ sequence }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Sync acknowledgement failed with HTTP ${response.status}`);
}

/** Push pending local mutations first, then pull/apply every available server page. */
export async function syncWorkspace(endpoint: string | URL, accessToken: string, scope: WorkspaceScope, deviceID: string, fetcher: typeof fetch = fetch): Promise<{ pushed: number; pulled: number; cursor: number }> {
  const pushed = await replayOutbox(scope, (currentScope, records) => sendRecords(endpoint, accessToken, currentScope, records, fetcher));
  let cursor = await loadChangeCursor(scope, deviceID);
  let pulled = 0;
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const page = await pullChanges(endpoint, accessToken, scope, deviceID, cursor, 100, fetcher);
    if (page.changes.length) {
      const appliedThrough = await applyRemoteChanges(scope, page.changes);
      cursor = Math.max(cursor, appliedThrough);
      await saveChangeCursor(scope, deviceID, cursor);
      await acknowledgeCursor(endpoint, accessToken, scope, deviceID, cursor, fetcher);
      pulled += page.changes.length;
    }
    if (!page.hasMore || page.changes.length === 0) break;
  }
  return { pushed, pulled, cursor };
}
