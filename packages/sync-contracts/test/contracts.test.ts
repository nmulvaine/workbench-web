import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AI_ONLY_KINDS,
  CURRENT_PROTOCOL_VERSION,
  EntityKind,
  MergeDecision,
  WORKBENCH_WORKSPACE_ID,
  after,
  canonicalJSON,
  hashRecord,
  makeRevision,
  mergeDecision,
  preservesConcurrentTextEdits,
  recordMutationID,
  revisionGreater,
  revisionsEqual,
  isSyncableKind,
  validateAsset,
  validateEnvelope,
  validateRecord,
} from "../src/index.js";
import { encodePayload, FIXTURE_DEVICE_A, FIXTURE_DEVICE_B, FIXTURE_WORKSPACE_ID, makeRecord } from "../src/fixtures.js";
import type { ChangeEnvelope } from "../src/envelope.js";
import type { SyncableRecord } from "../src/record.js";

const protocolEnvelope = readFileSync(new URL("./fixtures/protocol-v1-envelope.json", import.meta.url), "utf8").trim();
const tombstoneAssetsEnvelope = readFileSync(new URL("./fixtures/apple-protocol-v1-tombstone-assets.json", import.meta.url), "utf8").trim();

describe("native Workbench Sync Protocol v1 fixtures", () => {
  it("accepts and canonically re-encodes the Rust protocol envelope byte-for-byte", () => {
    const envelope = JSON.parse(protocolEnvelope);
    expect(() => validateEnvelope(envelope)).not.toThrow();
    expect(canonicalJSON(envelope)).toBe(protocolEnvelope);
    expect(envelope.workspaceID).toBe(WORKBENCH_WORKSPACE_ID);
    expect(envelope.records[0].payload).toBe("cGF5bG9hZA==");
  });

  it("accepts and canonically re-encodes the native tombstone and asset fixture", () => {
    const envelope = JSON.parse(tombstoneAssetsEnvelope);
    expect(() => validateEnvelope(envelope)).not.toThrow();
    expect(canonicalJSON(envelope)).toBe(tombstoneAssetsEnvelope);
    expect(envelope.records[0].isTombstone).toBe(true);
    expect(() => validateAsset(envelope.assets[0])).not.toThrow();
  });

  it("derives mutation IDs exactly like SyncRecord::mutation_id without putting them on the wire", () => {
    const record = JSON.parse(protocolEnvelope).records[0] as SyncableRecord;
    expect(recordMutationID(record)).toBe("project:11111111-1111-1111-1111-111111111111:7:AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
    expect(record).not.toHaveProperty("mutationID");
  });
});

describe("canonical encoding", () => {
  it("sorts nested and integer-like keys like Rust BTreeMap and escapes slashes", () => {
    expect(canonicalJSON({ "2": "two", "10": "ten", path: "photos/a.png" }))
      .toBe('{"10":"ten","2":"two","path":"photos\\/a.png"}');
    expect(canonicalJSON({ "\uE000": 1, "𐀀": 2 })).toBe('{"":1,"𐀀":2}');
  });

  it("preserves unknown fields when parsing and re-encoding records", () => {
    const record = { ...JSON.parse(protocolEnvelope).records[0], futureField: { nested: true } };
    expect(canonicalJSON(JSON.parse(canonicalJSON(record)))).toBe(canonicalJSON(record));
    expect(JSON.parse(canonicalJSON(record)).futureField).toEqual({ nested: true });
  });
});

describe("revision and merge behavior", () => {
  it("orders revisions by counter then origin device ID", () => {
    const a = makeRevision(1, FIXTURE_DEVICE_A);
    const b = makeRevision(2, FIXTURE_DEVICE_A);
    const c = makeRevision(1, FIXTURE_DEVICE_B);
    expect(revisionGreater(b, a)).toBe(true);
    expect(revisionGreater(a, b)).toBe(false);
    expect(revisionGreater(c, a)).toBe(true);
    expect(revisionsEqual(makeRevision(3, "x"), makeRevision(3, "x"))).toBe(true);
  });

  it("uses the Rust conflict-preservation kind set", () => {
    for (const kind of [EntityKind.Idea, EntityKind.Project, EntityKind.VoiceMemo, EntityKind.BoardItem, EntityKind.WikiPage, EntityKind.BrainstormTurn]) {
      expect(preservesConcurrentTextEdits(kind)).toBe(true);
    }
    expect(preservesConcurrentTextEdits(EntityKind.Note)).toBe(false);
    expect(AI_ONLY_KINDS.has(EntityKind.Analysis)).toBe(true);
    expect(isSyncableKind(EntityKind.BrainstormTurn)).toBe(true);
    expect(isSyncableKind(EntityKind.Analysis)).toBe(false);
  });

  it("preserves equal-counter concurrent text changes and keeps non-text ties", () => {
    const local = makeRecord(EntityKind.Idea, { text: "local" }, 5, FIXTURE_DEVICE_A);
    const remote: SyncableRecord = { ...makeRecord(EntityKind.Idea, { text: "remote" }, 5, FIXTURE_DEVICE_B), modifiedAt: "1970-01-01T00:00:01Z" };
    expect(mergeDecision(local, remote)).toBe(MergeDecision.preserveConflict);

    const localMemo = makeRecord(EntityKind.VoiceMemo, { title: "same" }, 5, FIXTURE_DEVICE_A);
    const remoteMemo = { ...localMemo, revision: makeRevision(5, FIXTURE_DEVICE_B), payload: encodePayload({ title: "different" }) };
    expect(mergeDecision(localMemo, remoteMemo)).toBe(MergeDecision.preserveConflict);

    const localNote = makeRecord(EntityKind.Note, { body: "local" }, 5, FIXTURE_DEVICE_A);
    const remoteNote = { ...localNote, revision: makeRevision(5, FIXTURE_DEVICE_B), payload: encodePayload({ body: "remote" }) };
    expect(mergeDecision(localNote, remoteNote)).toBe(MergeDecision.acceptRemote);
  });

  it("keeps local when its causal history already observes the remote mutation", () => {
    const remote = makeRecord(EntityKind.Project, { title: "remote" }, 3, FIXTURE_DEVICE_B);
    const local: SyncableRecord = { ...makeRecord(EntityKind.Project, { title: "local" }, 4, FIXTURE_DEVICE_A), causalHistory: { [FIXTURE_DEVICE_B]: 3 } };
    expect(mergeDecision(local, remote)).toBe(MergeDecision.keepLocal);
  });

  it("preserves unequal-counter edits and delete/edit pairs when native records carry causalHistory", () => {
    const local = { ...makeRecord(EntityKind.Project, { strings: { title: "local" } }, 2, FIXTURE_DEVICE_A), causalHistory: {} };
    const remote = { ...makeRecord(EntityKind.Project, { strings: { title: "remote" } }, 9, FIXTURE_DEVICE_B), causalHistory: {} };
    expect(mergeDecision(local, remote)).toBe(MergeDecision.preserveConflict);
    expect(mergeDecision(local, { ...remote, isTombstone: true })).toBe(MergeDecision.preserveConflict);
  });

  it("hashes canonical record bytes and derives stable retry IDs", async () => {
    const record = makeRecord(EntityKind.Project, { title: "Roadmap" });
    expect(await hashRecord(record)).toMatch(/^[0-9a-f]{64}$/);
    expect(recordMutationID(JSON.parse(canonicalJSON(record)))).toBe(recordMutationID(record));
  });
});

describe("wire validation and cursors", () => {
  it("accepts a valid record and rejects malformed records and non-base64 payload shapes", () => {
    const record = JSON.parse(protocolEnvelope).records[0];
    expect(() => validateRecord(record)).not.toThrow();
    expect(() => validateRecord({ ...record, payload: {} })).toThrow(/base64/);
    expect(() => validateRecord({ ...record, revision: { counter: -1, originDeviceID: FIXTURE_DEVICE_A } })).toThrow(/revision/);
  });

  it("requires the protocol workspace identity and valid sequence range", () => {
    const envelope: ChangeEnvelope = JSON.parse(protocolEnvelope);
    expect(() => validateEnvelope(envelope)).not.toThrow();
    expect(() => validateEnvelope({ ...envelope, protocolVersion: CURRENT_PROTOCOL_VERSION + 1 })).toThrow(/protocolVersion/);
    expect(() => validateEnvelope({ ...envelope, workspaceID: "other" })).toThrow(/workspace identity/);
    expect(() => validateEnvelope({ ...envelope, sequenceStart: 8, sequenceEnd: 7 })).toThrow(/sequenceEnd before/);
    expect(FIXTURE_WORKSPACE_ID).toBe(WORKBENCH_WORKSPACE_ID);
  });

  it("reports sequences strictly after a cursor", () => {
    const cursor = { workspaceID: FIXTURE_WORKSPACE_ID, sequence: 7 };
    expect(after(cursor, 8)).toBe(true);
    expect(after(cursor, 7)).toBe(false);
  });
});
