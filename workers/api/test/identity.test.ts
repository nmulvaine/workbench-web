import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyIdentityToken } from "../src/identity.js";

const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

describe("verified OIDC identity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a correctly signed token only for the configured issuer and audience", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "current-key", alg: "RS256", use: "sig" };
    const fetchStub = vi.fn(async () => Response.json({ keys: [jwk] }, { headers: { "Cache-Control": "max-age=30" } }));
    vi.stubGlobal("fetch", fetchStub);
    const issuer = "https://identity.example.test/";
    const header = encode({ alg: "RS256", kid: "current-key", typ: "JWT" });
    const payload = encode({ iss: issuer, aud: "workbench-web", sub: "user-123", exp: Math.floor(Date.now() / 1000) + 120 });
    const signed = new TextEncoder().encode(`${header}.${payload}`);
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, signed));
    const token = `${header}.${payload}.${btoa(String.fromCharCode(...signature)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
    const request = new Request("https://sync.example.test/sync", { headers: { Authorization: `Bearer ${token}` } });
    const claims = await verifyIdentityToken(request, { AUTH_ISSUER: issuer, AUTH_AUDIENCE: "workbench-web", AUTH_JWKS_URL: "https://identity.example.test/.well-known/jwks.json" });
    expect(claims.sub).toBe("user-123");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("accepts a matching signing key when the optional JWK alg field is omitted", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "key-without-alg", use: "sig" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [jwk] })));
    const issuer = "https://identity.example.test/";
    const header = encode({ alg: "RS256", kid: "key-without-alg" });
    const payload = encode({ iss: issuer, aud: "workbench-web", sub: "user-123", exp: Math.floor(Date.now() / 1000) + 120 });
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)));
    const token = `${header}.${payload}.${btoa(String.fromCharCode(...signature)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
    const request = new Request("https://sync.example.test/sync", { headers: { Authorization: `Bearer ${token}` } });
    await expect(verifyIdentityToken(request, { AUTH_ISSUER: issuer, AUTH_AUDIENCE: "workbench-web", AUTH_JWKS_URL: "https://identity.example.test/jwks" })).resolves.toMatchObject({ sub: "user-123" });
  });

  it("rejects a bearer string when identity-provider configuration is missing", async () => {
    const request = new Request("https://sync.example.test/sync", { headers: { Authorization: "Bearer abc.def.ghi" } });
    await expect(verifyIdentityToken(request, {})).rejects.toThrow(/not configured/);
  });

  it("rejects a token with an invalid signature", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "current-key", alg: "RS256", use: "sig" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [jwk] })));
    const header = encode({ alg: "RS256", kid: "current-key" });
    const payload = encode({ iss: "https://identity.example.test/", aud: "workbench-web", sub: "user-123", exp: Math.floor(Date.now() / 1000) + 120 });
    const request = new Request("https://sync.example.test/sync", { headers: { Authorization: `Bearer ${header}.${payload}.bad-signature` } });
    await expect(verifyIdentityToken(request, { AUTH_ISSUER: "https://identity.example.test/", AUTH_AUDIENCE: "workbench-web", AUTH_JWKS_URL: "https://identity.example.test/jwks" })).rejects.toThrow();
  });
});
