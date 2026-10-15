import { describe, it, expect } from "vitest";
import {
  EntityKind,
  AI_ONLY_KINDS,
  preservesConcurrentTextEdits,
  CURRENT_PROTOCOL_VERSION,
  makeRevision,
  revisionsEqual,
  revisionGreater,
  recordMutationID,
  canonicalJSON,
  hashRecord,
  validateRecord,
  MergeDecision,
  mergeDecision,
  validateAsset,
  validateEnvelope,
  after,
} from "../src/index.js";
import {
  FIXTURE_WORKSPACE_ID,
  FIXTURE_DEVICE_A,
  FIXTURE_DEVICE_B,
  makeRecord,
  sampleProject,
  sampleIdea,
  sampleTask,
  sampleNote,
  sampleBoardItem,
  sampleVoiceMemo,
  sampleWikiPage,
} from "../src/fixtures.js";

describe("revision ordering", () => {
  it("orders by counter then origin device id", () => {
    const a = makeRevision(1, "dev-a");
    const b = makeRevision(2, "dev-a");
    const c = makeRevision(1, "dev-b");
    expect(revisionGreater(b, a)).toBe(true);
    expect(revisionGreater(a, b)).toBe(false);
    expect(revisionGreater(c, a)).toBe(true); // same counter, greater device id
    expect(revisionsEqual(makeRevision(3, "x"), makeRevision(3, "x"))).toBe(true);
  });
});

describe("mutation id idempotency", () => {
  it("is stable across re-serialization and platforms", () => {
    const r = sampleIdea;
    expect(recordMutationID(r)).toBe(`idea:${r.id}:1:${FIXTURE_DEVICE_A}`);
    // Re-parsing canonical JSON yields the same id.
    const roundTripped = JSON.parse(canonicalJSON(r));
    expect(recordMutationID(roundTripped)).toBe(recordMutationID(r));
  });
});

describe("canonical JSON", () => {
  it("sorts keys deterministically regardless of insertion order", () => {
    const a = canonicalJSON({ b: 1, a: 2, c: { d: 4, e: 3 } });
    const b = canonicalJSON({ c: { e: 3, d: 4 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ a: 2, b: 1, c: { d: 4, e: 3 } });
  });
});

describe("record hashing", () => {
  it("produces identical hashes for equal records across platforms", async () => {
    const h1 = await hashRecord(sampleProject);
    const roundTripped = JSON.parse(canonicalJSON(sampleProject));
    const h2 = await hashRecord(roundTripped);
    expect(h2).toBe(h1);
    // Different payload -> different hash.
    const other = makeRecord(EntityKind.Project, {
      id: sampleProject.id,
      title: "Different",
      notes: sampleProject.payload.notes,
      createdAt: sampleProject.modifiedAt,
      updatedAt: sampleProject.modifiedAt,
    });
    const h3 = await hashRecord(other);
    expect(h3).not.toBe(h1);
  });

  it("exposes a stable hex digest length", async () => {
    const h = await hashRecord(sampleIdea);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("record validation", () => {
  it("accepts well-formed records", () => {
    expect(() => validateRecord(sampleTask)).not.toThrow();
  });

  it("rejects malformed records", () => {
    expect(() => validateRecord({})).toThrow(/missing field/);
    expect(() => validateRecord({ ...sampleIdea, entityKind: "bogus" })).toThrow(/invalid entityKind/);
    expect(() => validateRecord({ ...sampleIdea, schemaVersion: 0 })).toThrow(/schemaVersion/);
    expect(() => validateRecord("nope")).toThrow();
  });
});

describe("entity kind capabilities", () => {
  it("excludes AI-only kinds from sync", () => {
    for (const k of [EntityKind.Analysis, EntityKind.BrainstormTurn, EntityKind.TrainingRun, EntityKind.Adapter]) {
      expect(AI_ONLY_KINDS.has(k)).toBe(true);
    }
    // All fixture kinds are syncable.
    for (const r of [sampleProject, sampleIdea, sampleTask, sampleNote, sampleBoardItem, sampleVoiceMemo, sampleWikiPage]) {
      expect(AI_ONLY_KINDS.has(r.entityKind)).toBe(false);
    }
  });

  it("flags text-bearing kinds for conflict copies", () => {
    expect(preservesConcurrentTextEdits(EntityKind.Idea)).toBe(true);
    expect(preservesConcurrentTextEdits(EntityKind.Note)).toBe(true);
    expect(preservesConcurrentTextEdits(EntityKind.BoardItem)).toBe(true);
    expect(preservesConcurrentTextEdits(EntityKind.VoiceMemo)).toBe(false);
  });
});

describe("merge decisions", () => {
  it("accepts remote when there is no local record", () => {
    expect(mergeDecision(undefined, sampleIdea)).toBe(MergeDecision.acceptRemote);
  });

  it("keeps local on idempotent replay (same mutation id)", () => {
    const local = makeRecord(EntityKind.Idea, { id: "idea-x", content: "local edit" }, 5, FIXTURE_DEVICE_A);
    const remote = { ...local, payload: { id: "idea-x", content: "remote variant" }, modifiedAt: "2026-01-02T00:00:00.000Z" };
    expect(mergeDecision(local, remote)).toBe(MergeDecision.keepLocal);
  });

  it("preserves conflict for concurrent text edits to the same revision", () => {
    const local = makeRecord(EntityKind.Idea, { id: "idea-x", content: "local edit" }, 5, FIXTURE_DEVICE_A);
    const remote = makeRecord(EntityKind.Idea, { id: "idea-x", content: "remote edit" }, 5, FIXTURE_DEVICE_B);
    expect(mergeDecision(local, remote)).toBe(MergeDecision.preserveConflict);
  });

  it("accepts remote when causally contained", () => {
    const local = makeRecord(EntityKind.Note, { id: "n1", body: "a" }, 3, FIXTURE_DEVICE_A);
    const remote = makeRecord(EntityKind.Note, { id: "n1", body: "b" }, 4, FIXTURE_DEVICE_B);
    // remote carries causal history showing it contains local's change.
    remote.causalHistory = { [FIXTURE_DEVICE_A]: 3 };
    expect(mergeDecision(local, remote)).toBe(MergeDecision.acceptRemote);
  });

  it("keeps local when the revision is strictly greater", () => {
    const local = makeRecord(EntityKind.Note, { id: "n1", body: "local" }, 7, FIXTURE_DEVICE_A);
    const remote = makeRecord(EntityKind.Note, { id: "n1", body: "remote" }, 6, FIXTURE_DEVICE_B);
    expect(mergeDecision(local, remote)).toBe(MergeDecision.keepLocal);
  });

  it("does not preserve conflict for non-text kinds (overwrites)", () => {
    const local = makeRecord(EntityKind.VoiceMemo, { id: "v1", title: "a" }, 5, FIXTURE_DEVICE_A);
    const remote = makeRecord(EntityKind.VoiceMemo, { id: "v1", title: "b" }, 5, FIXTURE_DEVICE_B);
    // Equal revision + differing payload on a non-text kind resolves to keepLocal, never preserveConflict.
    expect(mergeDecision(local, remote)).toBe(MergeDecision.keepLocal);
    expect(mergeDecision(remote, local)).not.toBe(MergeDecision.preserveConflict);
  });
});

describe("asset manifests", () => {
  const manifest = {
    id: "asset-1",
    ownerRecordID: sampleProject.id,
    contentHash: "abc123",
    byteCount: 2048,
    mediaType: "image/png",
    logicalPath: "projects/proj-1/photos/photo.png",
    chunkSize: 1024,
    chunkHashes: ["h1", "h2"],
  };

  it("validates well-formed manifests", () => {
    expect(() => validateAsset(manifest)).not.toThrow();
  });

  it("rejects malformed manifests", () => {
    expect(() => validateAsset({ ...manifest, byteCount: -1 })).toThrow(/byteCount/);
    expect(() => validateAsset({ ...manifest, chunkSize: 0 })).toThrow(/chunkSize/);
    expect(() => validateAsset("nope")).toThrow();
  });

  it("computes a stable manifest hash", async () => {
    const h = await import("../src/asset.js").then((m) => m.hashAssetManifest(manifest));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("envelope validation", () => {
  it("accepts a current-protocol envelope", () => {
    const env = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      workspaceID: FIXTURE_WORKSPACE_ID,
      senderDeviceID: FIXTURE_DEVICE_A,
      sequenceStart: 1,
      sequenceEnd: 5,
      records: [sampleIdea],
      assets: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => validateEnvelope(env)).not.toThrow();
  });

  it("rejects an outdated protocol version", () => {
    const env = { ...aboveEnv(), protocolVersion: CURRENT_PROTOCOL_VERSION - 1 };
    expect(() => validateEnvelope(env)).toThrow(/protocolVersion/);
  });

  it("rejects a reversed sequence range", () => {
    const env = aboveEnv();
    env.sequenceStart = 5;
    env.sequenceEnd = 1;
    expect(() => validateEnvelope(env)).toThrow(/sequenceEnd before/);
  });
});

function aboveEnv(): any {
  return {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    workspaceID: FIXTURE_WORKSPACE_ID,
    senderDeviceID: FIXTURE_DEVICE_A,
    sequenceStart: 1,
    sequenceEnd: 5,
    records: [sampleIdea],
    assets: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("cursor helpers", () => {
  it("reports strictly-greater sequences", () => {
    const cursor = { workspaceID: FIXTURE_WORKSPACE_ID, sequence: 3 };
    expect(after(cursor, 4)).toBe(true);
    expect(after(cursor, 3)).toBe(false);
  });
});
