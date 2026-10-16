import { describe, expect, it } from "vitest";
import { EntityKind, makeRevision } from "../../../packages/sync-contracts/src/index.js";
import { encodePayload } from "../../../packages/sync-contracts/src/fixtures.js";
import type { SyncableRecord } from "../../../packages/sync-contracts/src/record.js";
import { commitEnvelope, summarize, tombstonesRetained } from "../src/sync-service.js";

function mk(kind: EntityKind, id: string, counter = 1, device = "dev-a", isTombstone = false, body: unknown = { [id]: true }): SyncableRecord {
  return {
    id,
    entityKind: kind,
    schemaVersion: 1,
    revision: makeRevision(counter, device),
    modifiedAt: "1970-01-01T00:00:00Z",
    isTombstone,
    payload: encodePayload(body),
  };
}

function mutation(record: SyncableRecord) {
  return { sequence: record.revision.counter, record, outcome: "new" as const };
}

describe("commitEnvelope authorization", () => {
  it("rejects mutations from a revoked device", async () => {
    const result = await commitEnvelope({ deviceId: "dev-a", revoked: true }, 1, [mk(EntityKind.Idea, "idea-1")], []);
    expect(result.committedSequences).toHaveLength(0);
    expect(result.rejected[0]).toMatch(/revoked/);
  });

  it("requires a device identity", async () => {
    const result = await commitEnvelope(undefined, 1, [mk(EntityKind.Idea, "idea-1")], []);
    expect(result.committedSequences).toHaveLength(0);
    expect(result.rejected[0]).toMatch(/missing/);
  });
});

describe("commitEnvelope idempotency", () => {
  it("drops a replay of the same derived mutation ID without consuming a sequence", async () => {
    const record = mk(EntityKind.Idea, "idea-1");
    const first = await commitEnvelope({ deviceId: "dev-a", revoked: false }, 1, [record], []);
    expect(first.committedSequences).toEqual([1]);

    const replay = await commitEnvelope({ deviceId: "dev-a", revoked: false }, 2, [record], [mutation(record)]);
    expect(replay.committedSequences).toHaveLength(0);
  });

  it("commits a genuinely new mutation", async () => {
    const result = await commitEnvelope({ deviceId: "dev-a", revoked: false }, 1, [mk(EntityKind.Idea, "idea-1")], []);
    expect(result.committedSequences).toEqual([1]);
    expect(result.tombstones).toBe(0);
    expect(result.conflicts).toBe(0);
  });
});

describe("commitEnvelope conflict resolution", () => {
  it("preserves concurrent text edits as a conflict copy", async () => {
    const local = mk(EntityKind.Idea, "idea-1", 1, "dev-a", false, { text: "local" });
    const remote = mk(EntityKind.Idea, "idea-1", 1, "dev-b", false, { text: "remote" });
    const result = await commitEnvelope({ deviceId: "dev-b", revoked: false }, 2, [remote], [mutation(local)]);
    expect(result.conflicts).toBe(1);
    expect(result.conflictCopies).toHaveLength(1);
  });

  it("never persists a conflict copy for AI-only kinds", async () => {
    const result = await commitEnvelope({ deviceId: "dev-a", revoked: false }, 1, [mk(EntityKind.Analysis, "analysis-1")], []);
    expect(result.conflicts).toBe(1);
    expect(result.committedSequences).toHaveLength(0);
  });

  it("accepts a strictly greater revision", async () => {
    const local = mk(EntityKind.Idea, "idea-1", 1, "dev-a");
    const remote = mk(EntityKind.Idea, "idea-1", 2, "dev-b");
    const result = await commitEnvelope({ deviceId: "dev-b", revoked: false }, 2, [remote], [mutation(local)]);
    expect(result.conflicts).toBe(0);
    expect(result.committedSequences).toEqual([2]);
  });
});

describe("commitEnvelope tombstones and summaries", () => {
  it("retains a tombstone until a different peer acknowledges it", async () => {
    const tombstone = mk(EntityKind.Idea, "idea-1", 5, "dev-a", true);
    const result = await commitEnvelope({ deviceId: "dev-a", revoked: false }, 1, [tombstone], []);
    expect(result.tombstones).toBe(1);
    expect(tombstonesRetained([mutation(tombstone)], [], ["dev-a", "dev-b"])).toBe(1);
    expect(tombstonesRetained([mutation(tombstone)], [{ peerID: "dev-a", sequence: 5, timestamp: "1970-01-01T00:00:00Z" }], ["dev-a", "dev-b"])).toBe(1);
    expect(tombstonesRetained([mutation(tombstone)], [{ peerID: "dev-b", sequence: 4, timestamp: "1970-01-01T00:00:00Z" }], ["dev-a", "dev-b"])).toBe(1);
    expect(tombstonesRetained([mutation(tombstone)], [{ peerID: "dev-b", sequence: 5, timestamp: "1970-01-01T00:00:00Z" }], ["dev-a", "dev-b"])).toBe(0);
  });

  it("produces a compact commit summary", async () => {
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
