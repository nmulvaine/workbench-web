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

  it("allows browser preflight for the bearer-token sync API", async () => {
    const response = await worker.fetch(new Request("https://sync.example/sync/workspaces/id/mutations", {
      method: "OPTIONS",
      headers: { Origin: "https://workbench.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-workbench-device-id" },
    }), { ALLOWED_ORIGINS: "https://workbench.example" });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://workbench.example");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Workbench-Device-ID");
  });

  it("rejects origins outside the configured allowlist", async () => {
    const response = await worker.fetch(new Request("https://sync.example/sync", {
      method: "POST",
      headers: { Origin: "https://attacker.example", Authorization: "Bearer unverified-token" },
      body: "{}",
    }), { SYNC_ENABLED: "false", ALLOWED_ORIGINS: "https://workbench.example" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("does not grant browser origins wildcard access", async () => {
    const response = await worker.fetch(new Request("https://sync.example/sync", { method: "POST", body: "{}" }));
    expect(response.status).toBe(503);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("reports missing Cloudflare Access OIDC setup before starting login", async () => {
    const response = await worker.fetch(new Request("https://sync.example/sync/auth/config", {
      headers: { Origin: "https://workbench.example" },
    }), { ALLOWED_ORIGINS: "https://workbench.example" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "access_oidc_not_configured" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://workbench.example");
  });

  it("reports non-sensitive readiness blockers without accepting sync", async () => {
    const response = await worker.fetch(new Request("https://sync.example/sync/readiness"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      readiness: { sync: "disabled", identity: "unconfigured", database: "unbound", assets: "unbound" },
    });
  });

  it("reports ready only when every Cloudflare dependency is configured", async () => {
    const origin = "https://team.cloudflareaccess.com";
    const response = await worker.fetch(new Request("https://sync.example/sync/readiness"), {
      SYNC_ENABLED: "true",
      DB: {} as D1Database,
      ASSETS: {} as R2Bucket,
      AUTH_ISSUER: origin,
      AUTH_AUDIENCE: "client-id",
      AUTH_JWKS_URL: `${origin}/cdn-cgi/access/certs`,
      AUTH_CLIENT_ID: "client-id",
      AUTH_CLIENT_SECRET: "secret",
      AUTH_AUTHORIZATION_URL: `${origin}/cdn-cgi/access/sso/oidc/client-id/authorization`,
      AUTH_TOKEN_URL: `${origin}/cdn-cgi/access/sso/oidc/token`,
      AUTH_REDIRECT_URIS: "https://workbench.example",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ready: true,
      readiness: { sync: "enabled", identity: "configured", database: "bound", assets: "bound" },
    });
  });
});
