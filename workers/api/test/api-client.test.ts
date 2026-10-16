import { describe, expect, it } from "vitest";
import { FIXTURE_DEVICE_A, FIXTURE_WORKSPACE_ID, sampleProject } from "../../../packages/sync-contracts/src/fixtures.js";
import { pullChanges } from "../../../packages/storage/src/api-client.js";

describe("browser mutation pull client", () => {
  it("requests the scoped cursor page and validates the v1 records", async () => {
    let requested: URL | undefined;
    let deviceHeader: string | null = null;
    const fetcher: typeof fetch = async (input, init) => {
      requested = new URL(input.toString());
      deviceHeader = new Headers(init?.headers).get("X-Workbench-Device-ID");
      return Response.json({ workspaceID: FIXTURE_WORKSPACE_ID, changes: [{ sequence: 8, record: sampleProject, outcome: "new" }], nextCursor: 8, hasMore: false });
    };
    const page = await pullChanges("https://sync.example.test", "signed.jwt.token", { accountID: "account", workspaceID: FIXTURE_WORKSPACE_ID }, FIXTURE_DEVICE_A, 4, 20, fetcher);
    expect(requested?.pathname).toBe(`/sync/workspaces/${encodeURIComponent(FIXTURE_WORKSPACE_ID)}/mutations`);
    expect(requested?.searchParams.get("after")).toBe("4");
    expect(requested?.searchParams.get("limit")).toBe("20");
    expect(deviceHeader).toBe(FIXTURE_DEVICE_A);
    expect(page).toEqual({ changes: [{ sequence: 8, record: sampleProject, outcome: "new" }], nextCursor: 8, hasMore: false });
  });

  it("rejects a page from another workspace or malformed records", async () => {
    const badWorkspace: typeof fetch = async () => Response.json({ workspaceID: "other", changes: [], nextCursor: 0, hasMore: false });
    await expect(pullChanges("https://sync.example.test", "token", { accountID: "a", workspaceID: FIXTURE_WORKSPACE_ID }, FIXTURE_DEVICE_A, 0, 100, badWorkspace)).rejects.toThrow("invalid change page");
    const badRecord: typeof fetch = async () => Response.json({ workspaceID: FIXTURE_WORKSPACE_ID, changes: [{ sequence: 1, record: {}, outcome: "new" }], nextCursor: 1, hasMore: false });
    await expect(pullChanges("https://sync.example.test", "token", { accountID: "a", workspaceID: FIXTURE_WORKSPACE_ID }, FIXTURE_DEVICE_A, 0, 100, badRecord)).rejects.toThrow("malformed record");
  });
});
