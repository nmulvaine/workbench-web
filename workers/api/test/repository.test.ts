import { describe, expect, it } from "vitest";
import { EntityKind, makeRevision } from "../../../packages/sync-contracts/src/index.js";
import { encodePayload } from "../../../packages/sync-contracts/src/fixtures.js";
import type { SyncableRecord } from "../../../packages/sync-contracts/src/record.js";
import { commitRecords, StoreError, type DurableDB, type Principal } from "../src/repository.js";

const principal: Principal = { subject: "user-a", workspaceID: "workspace-a", deviceID: "device-a" };
function makeRecord(id: string, counter = 1): SyncableRecord {
  return { id, entityKind: EntityKind.Project, schemaVersion: 1, revision: makeRevision(counter, principal.deviceID), modifiedAt: "2026-10-14T12:00:00Z", isTombstone: false, payload: encodePayload({ title: id }) };
}

interface StoredMutation { workspace: string; sequence: number; mutationID: string; record: string; entityKind: string; recordID: string; outcome: string }

class FakeD1 implements DurableDB {
  cursor = 0;
  role = "owner";
  deviceRevoked = false;
  mutations: StoredMutation[] = [];
  conflicts: unknown[][] = [];
  devices = new Set(["device-a", "device-b"]);

  prepare(sql: string): D1PreparedStatement { return new FakeStatement(this, sql); }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const before = { cursor: this.cursor, mutations: structuredClone(this.mutations) };
    try {
      const output: D1Result<T>[] = [];
      for (const statement of statements as FakeStatement[]) {
        if (statement.sql.startsWith("UPDATE workspaces SET cursor")) {
          const [next, _workspace, _accountID, expected] = statement.values as [number, string, string, number];
          const changes = this.cursor === expected ? 1 : 0;
          if (changes) this.cursor = next;
          output.push(result<T>(changes));
        } else if (statement.sql.startsWith("INSERT INTO mutations")) {
          const [workspace, accountID, sequence, mutationID, recordID, entityKind, , , , , , record, outcome] = statement.values as [string, string, number, string, string, string, ...unknown[]];
          if (this.mutations.some((row) => row.workspace === `${workspace}:${accountID}` && row.mutationID === mutationID) || this.mutations.some((row) => row.workspace === `${workspace}:${accountID}` && row.sequence === sequence)) throw new Error("unique constraint");
          this.mutations.push({ workspace: `${workspace}:${accountID}`, sequence, mutationID, record: String(record), entityKind, recordID, outcome: String(outcome) });
          output.push(result<T>(1));
        } else if (statement.sql.startsWith("INSERT INTO conflicts")) {
          this.conflicts.push(statement.values);
          output.push(result<T>(1));
        } else if (statement.sql.startsWith("INSERT OR IGNORE INTO tombstones")) {
          output.push(result<T>(1));
        } else throw new Error(`unexpected SQL: ${statement.sql}`);
      }
      return output;
    } catch (error) {
      this.cursor = before.cursor;
      this.mutations = before.mutations;
      this.conflicts = [];
      throw error;
    }
  }
}

class FakeStatement implements D1PreparedStatement {
  values: unknown[] = [];
  constructor(readonly db: FakeD1, readonly sql: string) {}
  bind(...values: unknown[]): D1PreparedStatement { this.values = values; return this; }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    if (this.sql.includes("FROM workspace_members")) return (this.values[1] === principal.subject ? { role: this.db.role, account_id: principal.subject } : null) as T | null;
    if (this.sql.includes("FROM devices")) return (!this.db.deviceRevoked && this.db.devices.has(String(this.values[2])) && this.values[3] === principal.subject ? { id: this.values[2] } : null) as T | null;
    if (this.sql.includes("SELECT record_json FROM mutations")) {
      const [workspace, accountID, entityKind, recordID] = this.values as string[];
      const row = this.db.mutations.filter((item) => item.workspace === `${workspace}:${accountID}` && item.entityKind === entityKind && item.recordID === recordID && item.outcome === "new").sort((a, b) => b.sequence - a.sequence)[0];
      return row ? { record_json: row.record } as T : null;
    }
    if (this.sql.includes("SELECT cursor FROM workspaces")) return { cursor: this.db.cursor } as T;
    return null;
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const [workspace, accountID, ...mutationIDs] = this.values as string[];
    const rows = this.db.mutations.filter((row) => row.workspace === `${workspace}:${accountID}` && mutationIDs.includes(row.mutationID)).map(({ sequence, mutationID }) => ({ sequence, mutation_id: mutationID })) as T[];
    return { results: rows, success: true, meta: { changes: rows.length, last_row_id: 0, duration: 0 } };
  }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return result<T>(0); }
}

function result<T>(changes: number): D1Result<T> { return { results: [], success: true, meta: { changes, last_row_id: 0, duration: 0 } }; }

describe("durable mutation repository", () => {
  it("allocates a monotonic cursor and commits the canonical record atomically", async () => {
    const db = new FakeD1();
    const record = makeRecord("project-a");
    const accepted = await commitRecords(db, principal, [record]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].sequence).toBe(1);
    expect(accepted[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.cursor).toBe(1);
    expect(JSON.parse(db.mutations[0].record)).toEqual(record);
  });

  it("deduplicates retries and duplicate mutations within one batch", async () => {
    const db = new FakeD1();
    const record = makeRecord("project-a");
    expect((await commitRecords(db, principal, [record, record])).map((change) => change.sequence)).toEqual([1, 1]);
    expect(db.cursor).toBe(1);
    expect(db.mutations).toHaveLength(1);
    expect((await commitRecords(db, principal, [record]))[0].sequence).toBe(1);
    expect(db.cursor).toBe(1);
  });

  it("rejects foreign identities, viewers, revoked devices, and AI-only data", async () => {
    const db = new FakeD1();
    await expect(commitRecords(db, { ...principal, subject: "other-user" }, [makeRecord("p1")])).rejects.toMatchObject({ code: "FORBIDDEN" });
    db.role = "viewer";
    await expect(commitRecords(db, principal, [makeRecord("p2")])).rejects.toMatchObject({ code: "FORBIDDEN" });
    db.role = "owner";
    db.deviceRevoked = true;
    await expect(commitRecords(db, principal, [makeRecord("p3")])).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    db.deviceRevoked = false;
    await expect(commitRecords(db, principal, [{ ...makeRecord("ai"), entityKind: EntityKind.Analysis }])).rejects.toMatchObject({ code: "INVALID_RECORD" });
    expect(db.mutations).toHaveLength(0);
  });

  it("rejects a record whose revision origin differs from the authenticated device", async () => {
    const db = new FakeD1();
    const invalid = { ...makeRecord("project-a"), revision: makeRevision(1, "another-device") };
    await expect(commitRecords(db, principal, [invalid])).rejects.toBeInstanceOf(StoreError);
    expect(db.cursor).toBe(0);
  });

  it("stores both sides of a native causal conflict without replacing the current row", async () => {
    const db = new FakeD1();
    const local = { ...makeRecord("00000000-0000-4000-8000-000000000001", 2), causalHistory: {} };
    await commitRecords(db, principal, [local]);
    const remotePrincipal = { ...principal, deviceID: "device-b" };
    const remote = { ...makeRecord(local.id, 9), revision: makeRevision(9, remotePrincipal.deviceID), payload: encodePayload({ strings: { title: "other edit" } }), causalHistory: {} };
    await commitRecords(db, remotePrincipal, [remote]);
    expect(db.cursor).toBe(2);
    expect(db.mutations.map((item) => item.outcome)).toEqual(["new", "conflict"]);
    expect(db.conflicts).toHaveLength(1);
    expect(JSON.parse(db.conflicts[0][5] as string)).toEqual(local);
    expect(JSON.parse(db.conflicts[0][6] as string)).toEqual(remote);
  });

  it("rolls back a competing stale cursor allocation and allows retry", async () => {
    const db = new FakeD1();
    const [one, two] = await Promise.allSettled([
      commitRecords(db, principal, [makeRecord("00000000-0000-4000-8000-000000000001")]),
      commitRecords(db, principal, [makeRecord("00000000-0000-4000-8000-000000000002")]),
    ]);
    expect([one.status, two.status].filter((status) => status === "fulfilled")).toHaveLength(1);
    expect(db.cursor).toBe(1);
    expect(db.mutations).toHaveLength(1);
  });

  it("rolls back a concurrent duplicate mutation instead of advancing the cursor", async () => {
    const db = new FakeD1();
    const record = makeRecord("00000000-0000-4000-8000-000000000003");
    const [one, two] = await Promise.allSettled([
      commitRecords(db, principal, [record]),
      commitRecords(db, principal, [record]),
    ]);
    expect([one.status, two.status].filter((status) => status === "fulfilled")).toHaveLength(1);
    expect([one, two].filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual([
      expect.objectContaining({ code: "CONFLICT" }),
    ]);
    expect(db.cursor).toBe(1);
    expect(db.mutations).toHaveLength(1);
    expect((await commitRecords(db, principal, [record]))[0].sequence).toBe(1);
    expect(db.cursor).toBe(1);
  });
});
