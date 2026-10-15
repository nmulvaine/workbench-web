import { EntityKind } from "./entity-kind.js";
import { WORKBENCH_WORKSPACE_ID } from "./envelope.js";
import { canonicalJSON } from "./record.js";
import type { SyncableRecord } from "./record.js";
import { makeRevision } from "./revision.js";

/** IDs and wire shape shared with workbench-sync-core's protocol fixtures. */
export const FIXTURE_ACCOUNT_ID = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC";
export const FIXTURE_WORKSPACE_ID = WORKBENCH_WORKSPACE_ID;
export const FIXTURE_DEVICE_A = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
export const FIXTURE_DEVICE_B = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

let nextFixtureID = 1;

export function encodePayload(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

/** Builds a deterministic protocol v1 record; payload is base64 on the wire. */
export function makeRecord(
  kind: EntityKind,
  payload: unknown,
  revisionCounter = 1,
  originDeviceID = FIXTURE_DEVICE_A,
  schemaVersion = 1,
): SyncableRecord {
  const suffix = String(nextFixtureID++).padStart(12, "0");
  const record: SyncableRecord = {
    id: `00000000-0000-4000-8000-${suffix}`,
    entityKind: kind,
    schemaVersion,
    revision: makeRevision(revisionCounter, originDeviceID),
    modifiedAt: "1970-01-01T00:00:00Z",
    isTombstone: false,
    payload: encodePayload(payload),
  };
  return record;
}

export const sampleProject = makeRecord(EntityKind.Project, {
  strings: { title: "Roadmap", notes: "Q1 priorities and milestones." },
});

export const sampleIdea = makeRecord(EntityKind.Idea, {
  strings: { title: "Add cloud sync support", content: "Add cloud sync support." },
});

export const sampleTask = makeRecord(EntityKind.Task, {
  strings: { title: "Write sync protocol adapter", status: "in-progress" },
});

export const sampleNote = makeRecord(EntityKind.Note, {
  strings: { body: "Meeting notes from the sync design session." },
});

export const sampleBoardItem = makeRecord(EntityKind.BoardItem, {
  strings: { title: "Design sketch", text: "Wireframe of the dashboard layout." },
});

export const sampleVoiceMemo = makeRecord(EntityKind.VoiceMemo, {
  strings: { title: "Voice memo" },
});

export const sampleWikiPage = makeRecord(EntityKind.WikiPage, {
  strings: { title: "Sync architecture", body: "How records and assets flow through the cloud." },
});
