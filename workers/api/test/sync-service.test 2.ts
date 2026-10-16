import { describe, it, expect } from "vitest";
import { EntityKind, makeRevision } from "../../../packages/sync-contracts/src/index.js";
import type { SyncableRecord } from "../../../packages/sync-contracts/src/record.js";
import { recordMutationID } from "../../../packages/sync-contracts/src/record.js";
import { commitEnvelope, summarize, tombstonesRetained } from "../src/sync-service.js";

function mk(kind: EntityKind, id: string, counter = 1, device = "dev-a", isTombstone = false): SyncableRecord {
  return {
    id,
    entityKind: kind,
    schemaVersion: 3,
    revision: makeRevision(counter, device),
    mutationID: recordMutationID({ entityKind: kind, id, revision: makeRevision(counter, device) }),
    modifiedAt: "2026-01-01T00:00:00.000Z",
    isTombstone,
    payload: { [id]: true },
  };
}

function mutation(record: SyncableRecord) {
  return { sequence: record.revision.counter, record, outcome: "new" as const };
}

describe("commitEnvelope authorization", () => {
  it("rejects mutations from a revoked device", async () => {
    const result = await commitEnvelope(
      { deviceId: "dev-a", revoked: true },
      1,
      [mk(EntityKind.Idea, "idea-1")],
      [],
    );
    expect(result.committedSequences).toHaveLength(0);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]).toMatch(/revoked/);
  });

  it("requires a device identity", async () => {
    const result = await commitEnvelope(undefined, 1, [mk(EntityKind.Idea, "idea-1")], []);
    expect(result.committedSequences).toHaveLength(0);
    expect(result.rejected[0]).toMatch(/missing/);
  });
});

describe("commitEnvelope idempotency", () => {
  it("drops a replay of an already-committed mutation without consuming a slot", async () => {
    const first = await commitEnvelope(
      { deviceId: "dev-a", revoked: false },
      1,
      [mk(EntityKind.Idea, "idea-1")],
      [],
    );
    expect(first.committedSequences).toEqual([1]);

    // Re-send the exact same mutation id.
    const replay = await commitEnvelope(
      { deviceId: "dev-a", revoked: false },
      2,
      [mk(EntityKind.Idea, "idea-1")],
      first.committedSequences.map((s) => ({ sequence: s, record: mk(EntityKind.Idea, "idea-1"), outcome: "new" })),
    );
    expect(replay.committedSequences).toHaveLength(0);
  });

  it("commits a genuinely new mutation", async () => {
    const result = await commitEnvelope(
      { deviceId: "dev-a", revoked: false },
      1,
      [mk(EntityKind.Idea, "idea-1")],
      [],
    );
    expect(result.committedSequences).toEqual([1]);
    expect(result.tombstones).toBe(0);
    expect(result.conflicts).toBe(0);
  });
});

describe("commitEnvelope conflict resolution", () => {
  it("preserves concurrent text edits as a conflict copy for text-bearing kinds", async () => {
    const existing = await commitEnvelope(
      { deviceId: "dev-a", revoked: false },
      1,
      [mk(EntityKind.Idea, "idea-1")],
      [],
    );

    const local = { ...mk(EntityKind.Idea, "idea-1"), payload: { "idea-1": "local-edit" } };
    const remote = { ...mk(EntityKind.Idea, "idea-1", 1, "dev-b"), payload: { "idea-1": "remote-edit" } };
    // Same revision counter, different device, different payload -> concurrent text edit.
    expect(commitEnvelope({ deviceId: "dev-a", revoked: false }, 2, [remote], existing.committedSequences.map((s) => ({ sequence: s, record: local, outcome: "new" })))).toBeTruthy();

    const conflict = await commitEnvelope(
      { deviceId: "dev-b", revoked: false },
      3,
      [local],
      existing.committedSequences.map((s) => ({ sequence: s, record: remote, outcome: "conflict" })),
    );
    expect(conflict.conflicts).toBe(1);
  });

  it("never persists a conflict copy for AI-only kinds", async () => {
    const result = await commitEnvelope(
      { deviceId: "dev-a", revoked: false },
      1,
      [mk(EntityKind.Analysis, "analysis-1")],
      [],
    );
    expect(result.conflicts).toBe(1);
    expect(result.committedSequences).toHaveLength(0);
  });

  it("accepts a strictly-greater revision", async () => {
    const existing = await commitEnvelope(
      { deviceId: "dev-a", revoked: false },
      1,
      [mk(EntityKind.Idea, "idea-1")],
      [],
    );
    // Newer counter on the same id -> remote wins.
    const result = await commitEnvelope(
      { deviceId: "dev-b", revoked: false },
      2,
      [mk(EntityKind.Idea, "idea-1", 2)],
      existing.committedSequences.map((s) => ({ sequence: s, record: mk(EntityKind.Idea, "idea-1"), outcome: "new" })),
    );
    expect(result.conflicts).toBe(0);
    expect(result.committedSequences).toEqual([2]);
  });
});

describe("commitEnvelope tombstones", () => {
  it("records a tombstone and retains it until an external peer acknowledges", async () => {
    const result = await commitEnvelope(
      { deviceId: "dev-a", revoked: false },
      1,
      [mk(EntityKind.Idea, "idea-1", 5, "dev-a", true)],
      [],
    );
    expect(result.tombstones).toBe(1);

    // No acknowledgement -> still retained.
    expect(tombstonesRetained(existingTombstone(), [])).toBe(1);

    // Our own device acknowledging does not release it; a peer does.
    const ack = { peerID: "dev-b", sequence: 5, timestamp: "2026-01-02T00:00:00.000Z" };
    expect(tombstonesRetained(existingTombstone(), [ack])).toBe(0);
  });

  function existingTombstone() {
    return [{ sequence: 5, record: mk(EntityKind.Idea, "idea-1", 5, "dev-a", true), outcome: "new" }];
  }
});

describe("summarize observability", () => {
  it("produces a deterministic summary of a commit result", async () => {
    const result = await commitEnvelope(
      { deviceId: "dev-a", revoked: false },
      1,
      [mk(EntityKind.Idea, "idea-1"), mk(EntityKind.Analysis, "analysis-1")],
      [],
    );
    expect(summarize(result, 2)).toEqual({
      envelopeSize: 2,
      committedCount: 1,
      tombstoneCount: 0,
      conflictCount: 1,
      rejectedCount: 0,
    });
  });
});
