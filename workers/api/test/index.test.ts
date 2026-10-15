import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

describe("sync API fail-closed routes", () => {
  it("returns 503 for sync without consuming an authenticated request body", async () => {
    const request = new Request("https://sync.example/sync", {
      method: "POST",
      headers: { Authorization: "Bearer unverified-token" },
      body: "must remain unconsumed",
    });
    const bodyUsedBefore = request.bodyUsed;

    const response = await worker.fetch(request);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "sync_unavailable" });
    expect(bodyUsedBefore).toBe(false);
    expect(request.bodyUsed).toBe(false);
  });

  it("returns 405 and advertises the required method", async () => {
    const response = await worker.fetch(new Request("https://sync.example/sync"));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });

  it("returns 404 for unknown routes", async () => {
    const response = await worker.fetch(new Request("https://sync.example/other"));
    expect(response.status).toBe(404);
  });
});
