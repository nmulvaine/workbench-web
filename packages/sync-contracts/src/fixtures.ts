import { EntityKind, makeRevision } from "./index.js";
import { recordMutationID } from "./record.js";

/** Deterministic UUIDs used across fixtures so hashes are reproducible. */
export const FIXTURE_ACCOUNT_ID = "acct-0001";
export const FIXTURE_WORKSPACE_ID = "ws-0001";
export const FIXTURE_DEVICE_A = "dev-macbook-pro";
export const FIXTURE_DEVICE_B = "dev-iphone-16";

/** Builds a canonical record for testing. */
export function makeRecord(
  kind: EntityKind,
  payload: unknown,
  revisionCounter = 1,
  originDeviceID = FIXTURE_DEVICE_A,
  schemaVersion = 3,
): any {
  const record = {
    id: `id-${kind}-${Math.random().toString(36).slice(2, 10)}`,
    entityKind: kind,
    schemaVersion,
    revision: makeRevision(revisionCounter, originDeviceID),
    modifiedAt: "2026-01-01T00:00:00.000Z",
    isTombstone: false,
    payload,
  };
  return {
    ...record,
    mutationID: recordMutationID(record),
  };
}

export const sampleProject = makeRecord(EntityKind.Project, {
  id: "proj-1",
  title: "Roadmap",
  notes: "Q1 priorities and milestones.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const sampleIdea = makeRecord(EntityKind.Idea, {
  id: "idea-1",
  content: "Add cloud sync support for the web client.",
  title: "Add cloud sync support for the web client.",
  category: "General",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const sampleTask = makeRecord(EntityKind.Task, {
  id: "task-1",
  title: "Write sync protocol adapter",
  status: "in-progress",
  priority: "High",
  dueDate: "2026-02-01T00:00:00.000Z",
  summaryOrder: 0,
});

export const sampleNote = makeRecord(EntityKind.Note, {
  id: "note-1",
  body: "Meeting notes from the sync design session.",
  tags: ["sync", "design"],
});

export const sampleBoardItem = makeRecord(EntityKind.BoardItem, {
  id: "board-1",
  kind: "note",
  title: "Design sketch",
  text: "Wireframe of the dashboard layout.",
  positionX: 100,
  positionY: 200,
  width: 300,
  height: 220,
  zIndex: 0,
});

export const sampleVoiceMemo = makeRecord(EntityKind.VoiceMemo, {
  id: "voice-1",
  title: "Voice memo",
  audioFileName: "voice-1.m4a",
  duration: 12.5,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

export const sampleWikiPage = makeRecord(EntityKind.WikiPage, {
  id: "wiki-1",
  title: "Sync architecture",
  body: "How records and assets flow through the cloud.",
  pageTypeRaw: "topic",
  lifecycleRaw: "published",
  confidenceRaw: "medium",
});
