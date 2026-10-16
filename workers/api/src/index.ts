import { verifyIdentityToken, type IdentityClaims } from "./identity.js";
import { commitRecords, StoreError } from "./repository.js";
import { getVerifiedAsset, initializeAssetUpload, putAssetChunk } from "./assets.js";
import { WORKBENCH_WORKSPACE_ID } from "../../../packages/sync-contracts/src/envelope.js";
import { validateEnvelope } from "../../../packages/sync-contracts/src/envelope.js";
import { sha256BytesHex } from "../../../packages/sync-contracts/src/record.js";

export interface Env {
  SYNC_ENABLED?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH_JWKS_URL?: string;
  AUTH_CLIENT_ID?: string;
  AUTH_CLIENT_SECRET?: string;
  AUTH_AUTHORIZATION_URL?: string;
  AUTH_TOKEN_URL?: string;
  AUTH_REDIRECT_URIS?: string;
  ALLOWED_ORIGINS?: string;
  DB?: D1Database;
  ASSETS?: R2Bucket;
  MAX_SYNC_BODY_BYTES?: string;
  MAX_ASSET_BYTES?: string;
  MAX_SNAPSHOT_BYTES?: string;
}

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const disabled = () => Response.json({ error: "sync_unavailable" }, { status: 503, headers: { ...headers, "Retry-After": "3600" } });

/**
 * Explicitly disabled in every checked-in environment. The authenticated route
 * below is available for staging only after all required bindings and policy
 * variables are configured; production still requires the cross-platform gate.
 */
export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const origin = request.headers.get("Origin");
    const allowedOrigins = new Set((env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
    if (origin && !allowedOrigins.has(origin)) {
      return Response.json({ error: "origin_not_allowed" }, { status: 403, headers });
    }
    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 204, headers });
      return new Response(null, { status: 204, headers: {
        ...headers,
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Workbench-Device-ID, X-Workbench-Snapshot-Path, X-Workbench-SHA256",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
      } });
    }
    const response = await handleSyncRequest(request, env);
    if (!origin) return response;
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", origin);
    responseHeaders.append("Vary", "Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  },
};

async function handleSyncRequest(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/sync" && !pathname.startsWith("/sync/")) {
      return Response.json({ error: "not_found" }, { status: 404, headers });
    }
    if (pathname === "/sync" && request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...headers, Allow: "POST" } });
    }
    if (pathname === "/sync/readiness" && request.method === "GET") {
      // Configuration only: do not expose account, workspace, binding, or IdP details.
      const readiness = {
        sync: env.SYNC_ENABLED === "true" ? "enabled" : "disabled",
        identity: hasAccessOIDCConfig(env) ? "configured" : "unconfigured",
        database: env.DB ? "bound" : "unbound",
        assets: env.ASSETS ? "bound" : "unbound",
      } as const;
      const ready = readiness.sync === "enabled" && readiness.identity === "configured" &&
        readiness.database === "bound" && readiness.assets === "bound";
      return Response.json({ ready, readiness }, { status: ready ? 200 : 503, headers });
    }
    if (pathname === "/sync/auth/config" && request.method === "GET") {
      if (!hasAccessOIDCConfig(env)) {
        console.warn("Access OIDC configuration is incomplete", {
          issuer: Boolean(env.AUTH_ISSUER), audience: Boolean(env.AUTH_AUDIENCE), jwks: Boolean(env.AUTH_JWKS_URL),
          clientID: Boolean(env.AUTH_CLIENT_ID), clientSecret: Boolean(env.AUTH_CLIENT_SECRET),
          authorizationURL: Boolean(env.AUTH_AUTHORIZATION_URL), tokenURL: Boolean(env.AUTH_TOKEN_URL),
          redirectURIs: Boolean(env.AUTH_REDIRECT_URIS), audienceMatchesClientID: env.AUTH_AUDIENCE === env.AUTH_CLIENT_ID,
        });
        return Response.json({ error: "access_oidc_not_configured" }, { status: 503, headers });
      }
      return Response.json({
        issuer: env.AUTH_ISSUER,
        clientID: env.AUTH_CLIENT_ID,
        authorizationURL: env.AUTH_AUTHORIZATION_URL,
      }, { headers });
    }
    if (pathname === "/sync/auth/token" && request.method === "POST") {
      if (!hasAccessOIDCConfig(env)) return Response.json({ error: "access_oidc_not_configured" }, { status: 503, headers });
      const body = await readJson(request, 16_384);
      const code = typeof body?.code === "string" ? body.code : "";
      const verifier = typeof body?.codeVerifier === "string" ? body.codeVerifier : "";
      const nonce = typeof body?.nonce === "string" ? body.nonce : "";
      const redirectURI = typeof body?.redirectURI === "string" ? body.redirectURI : "";
      const redirects = (env.AUTH_REDIRECT_URIS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          !/^[A-Za-z0-9_-]{20,128}$/.test(nonce) || !redirects.includes(redirectURI)) {
        return Response.json({ error: "invalid_authorization_code_request" }, { status: 400, headers });
      }
      try {
        const tokenResponse = await fetch(env.AUTH_TOKEN_URL!, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code", client_id: env.AUTH_CLIENT_ID!, client_secret: env.AUTH_CLIENT_SECRET!,
            code, redirect_uri: redirectURI, code_verifier: verifier,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const tokenBody = await tokenResponse.json().catch(() => undefined) as Record<string, unknown> | undefined;
        const idToken = typeof tokenBody?.id_token === "string" ? tokenBody.id_token : "";
        if (!tokenResponse.ok || !idToken) {
          console.warn("Access authorization code exchange failed", {
            status: tokenResponse.status,
            error: typeof tokenBody?.error === "string" ? tokenBody.error.slice(0, 120) : undefined,
            description: typeof tokenBody?.error_description === "string" ? tokenBody.error_description.slice(0, 240) : undefined,
          });
          return Response.json({ error: "access_token_exchange_failed" }, { status: 401, headers });
        }
        const claims = await verifyIdentityToken(new Request(request.url, { headers: { Authorization: `Bearer ${idToken}` } }), env);
        if (claims.nonce !== nonce) return Response.json({ error: "access_token_nonce_mismatch" }, { status: 401, headers });
        return Response.json({ idToken, expiresIn: tokenBody?.expires_in ?? null, subject: claims.sub }, { headers });
      } catch (error) {
        console.warn("Access authorization code exchange request failed", {
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message.slice(0, 240) : undefined,
        });
        return Response.json({ error: "access_token_exchange_failed" }, { status: 401, headers });
      }
    }
    if (env.SYNC_ENABLED !== "true" || !env.DB) return disabled();

    let claims: IdentityClaims;
    try {
      claims = await verifyIdentityToken(request, env);
    } catch {
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    }

    if (pathname === "/sync" && request.method === "POST") {
      const maxBytes = boundedInteger(env.MAX_SYNC_BODY_BYTES, 1_048_576, 8_388_608);
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > maxBytes) return Response.json({ error: "payload_too_large" }, { status: 413, headers });
      const body = await readJson(request, maxBytes);
      if (!body || !Array.isArray(body.records)) return Response.json({ error: "invalid_envelope" }, { status: 400, headers });
      try {
        const deviceID = request.headers.get("x-workbench-device-id");
        if (!deviceID) return Response.json({ error: "device_required" }, { status: 400, headers });
        try { validateEnvelope(body); } catch (error) { return Response.json({ error: "invalid_envelope", message: String(error) }, { status: 400, headers }); }
        if (body.senderDeviceID !== deviceID) return Response.json({ error: "sender_device_mismatch" }, { status: 403, headers });
        if (body.assets.length > 0) return Response.json({ error: "asset_transfer_endpoint_required" }, { status: 501, headers });
        const changes = await commitRecords(env.DB, { subject: claims.sub, workspaceID: WORKBENCH_WORKSPACE_ID, deviceID }, body.records);
        return Response.json({ accepted: changes.map(({ sequence, mutationID, hash }) => ({ sequence, mutationID, hash })) }, { headers });
      } catch (error) {
        if (error instanceof StoreError) {
          const status = error.code === "FORBIDDEN" || error.code === "DEVICE_REVOKED" ? 403 : error.code === "CONFLICT" ? 409 : 400;
          return Response.json({ error: error.code.toLowerCase(), message: error.message }, { status, headers });
        }
        return Response.json({ error: "storage_failure" }, { status: 503, headers });
      }
    }

    if (pathname === "/sync/enroll" && request.method === "POST") {
      const body = await readJson(request, 4096);
      if (!body || body.workspaceID !== WORKBENCH_WORKSPACE_ID) return Response.json({ error: "unsupported_workspace" }, { status: 400, headers });
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO accounts (id, created_at) VALUES (?, ?)").bind(claims.sub, new Date().toISOString()),
        env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, account_id, created_at) VALUES (?, ?, ?)").bind(WORKBENCH_WORKSPACE_ID, claims.sub, new Date().toISOString()),
        env.DB.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, account_id, subject, role) VALUES (?, ?, ?, 'owner')").bind(WORKBENCH_WORKSPACE_ID, claims.sub, claims.sub),
      ]);
      return Response.json({ workspaceID: WORKBENCH_WORKSPACE_ID, enrolled: true }, { status: 201, headers });
    }

    const deviceRevokeMatch = pathname.match(/^\/sync\/workspaces\/([^/]+)\/devices\/([^/]+)\/revoke$/);
    const snapshotsMatch = pathname.match(/^\/sync\/workspaces\/([^/]+)\/snapshots(?:\/([0-9a-f-]+))?$/i);
    const workspaceMatch = pathname.match(/^\/sync\/workspaces\/([^/]+)\/(cursor|mutations|acknowledgements|devices|conflicts)$/);
    const assetMatch = pathname.match(/^\/sync\/workspaces\/([^/]+)\/assets\/([^/]+)(?:\/(chunks))?$/);
    if (!workspaceMatch && !assetMatch && !deviceRevokeMatch && !snapshotsMatch) return Response.json({ error: "not_found" }, { status: 404, headers });
    const workspaceID = decodeURIComponent((workspaceMatch ?? assetMatch ?? deviceRevokeMatch ?? snapshotsMatch)![1]);
    const resource = workspaceMatch?.[2] ?? "assets";
    const membership = await env.DB.prepare(
      "SELECT role, account_id FROM workspace_members WHERE workspace_id = ? AND subject = ?",
    ).bind(workspaceID, claims.sub).first<{ role: string; account_id: string }>();
    if (!membership) return Response.json({ error: "forbidden" }, { status: 403, headers });
    const accountID = membership.account_id;

    if (assetMatch && !assetMatch[3] && request.method === "GET") {
      if (!env.ASSETS) return Response.json({ error: "asset_unavailable" }, { status: 503, headers });
      try {
        const asset = await getVerifiedAsset(env as Env & { DB: D1Database; ASSETS: R2Bucket }, {
          subject: claims.sub, accountID, workspaceID, deviceID: "",
        }, decodeURIComponent(assetMatch[2]));
        if (!asset) return Response.json({ error: "asset_not_found" }, { status: 404, headers });
        return new Response(asset.body, { headers: {
          ...headers,
          "Content-Type": asset.mediaType || "application/octet-stream",
          "Content-Length": String(asset.byteCount),
          "X-Workbench-Asset-SHA256": asset.contentHash,
          "X-Workbench-Asset-Path": asset.logicalPath,
          "Cache-Control": "private, no-store",
        } });
      } catch {
        return Response.json({ error: "asset_unavailable" }, { status: 503, headers });
      }
    }

    if (snapshotsMatch && !snapshotsMatch[2] && request.method === "GET") {
      const prefix = new URL(request.url).searchParams.get("prefix");
      if (prefix !== `Workbench/Sync/${workspaceID}`) return Response.json({ error: "invalid_snapshot_prefix" }, { status: 400, headers });
      const after = new URL(request.url).searchParams.get("after") ?? "";
      const limit = boundedInteger(new URL(request.url).searchParams.get("limit"), 100, 500);
      const snapshots = await env.DB.prepare(
        "SELECT snapshot_id, file_path, content_hash, byte_count, created_at FROM cloud_snapshots WHERE workspace_id = ? AND account_id = ? AND created_at > ? ORDER BY created_at, snapshot_id LIMIT ?",
      ).bind(workspaceID, accountID, after, limit).all<{ snapshot_id: string; file_path: string; content_hash: string; byte_count: number; created_at: string }>();
      return Response.json({ objects: snapshots.results.map((item) => ({ path: item.file_path, providerObjectId: item.snapshot_id, sha256: item.content_hash, byteCount: item.byte_count, createdAt: item.created_at, accountIdentity: accountID })) }, { headers });
    }
    if (snapshotsMatch?.[2] && request.method === "GET") {
      const snapshotID = decodeURIComponent(snapshotsMatch[2]);
      const row = await env.DB.prepare("SELECT object_key, content_hash, byte_count, file_path FROM cloud_snapshots WHERE workspace_id = ? AND account_id = ? AND snapshot_id = ?")
        .bind(workspaceID, accountID, snapshotID).first<{ object_key: string; content_hash: string; byte_count: number; file_path: string }>();
      if (!row || !env.ASSETS) return Response.json({ error: "snapshot_not_found" }, { status: 404, headers });
      const object = await env.ASSETS.get(row.object_key);
      if (!object || object.customMetadata?.accountID !== accountID || object.customMetadata?.sha256 !== row.content_hash) {
        return Response.json({ error: "snapshot_unavailable" }, { status: 503, headers });
      }
      return new Response(object.body, { headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(row.byte_count), "X-Workbench-Snapshot-Path": row.file_path, "X-Workbench-SHA256": row.content_hash, "Cache-Control": "private, no-store" } });
    }
    if (snapshotsMatch?.[2] && request.method === "PUT") {
      if (membership.role === "viewer" || !env.ASSETS) return Response.json({ error: "forbidden" }, { status: 403, headers });
      const snapshotID = decodeURIComponent(snapshotsMatch[2]);
      if (!isUUID(snapshotID)) return Response.json({ error: "invalid_snapshot_id" }, { status: 400, headers });
      const filePath = request.headers.get("x-workbench-snapshot-path") ?? "";
      const expectedHash = request.headers.get("x-workbench-sha256") ?? "";
      const expectedBytes = boundedInteger(request.headers.get("content-length"), -1, Number.MAX_SAFE_INTEGER);
      const expectedPath = `Workbench/Sync/${workspaceID}/${snapshotID.toUpperCase()}.workbenchworkspace`;
      if (filePath !== expectedPath || !/^[0-9a-f]{64}$/i.test(expectedHash) || expectedBytes < 0) return Response.json({ error: "invalid_snapshot_metadata" }, { status: 400, headers });
      const deviceID = request.headers.get("x-workbench-device-id");
      if (!deviceID) return Response.json({ error: "device_required" }, { status: 400, headers });
      const device = await env.DB.prepare("SELECT id FROM devices WHERE workspace_id = ? AND account_id = ? AND id = ? AND subject = ? AND revoked_at IS NULL").bind(workspaceID, accountID, deviceID, claims.sub).first();
      if (!device) return Response.json({ error: "device_not_authorized" }, { status: 403, headers });
      const prior = await env.DB.prepare("SELECT file_path, content_hash, byte_count FROM cloud_snapshots WHERE workspace_id = ? AND account_id = ? AND snapshot_id = ?").bind(workspaceID, accountID, snapshotID).first<{ file_path: string; content_hash: string; byte_count: number }>();
      if (prior) {
        if (prior.file_path !== filePath || prior.content_hash !== expectedHash.toLowerCase() || prior.byte_count !== expectedBytes) return Response.json({ error: "snapshot_id_conflict" }, { status: 409, headers });
        return Response.json({ created: false, path: filePath, sha256: prior.content_hash, byteCount: prior.byte_count }, { headers });
      }
      const maxBytes = boundedInteger(env.MAX_SNAPSHOT_BYTES, 67_108_864, 67_108_864);
      if (expectedBytes > maxBytes) return Response.json({ error: "snapshot_too_large", maxBytes }, { status: 413, headers });
      const bytes = await readBytes(request, maxBytes);
      if (!bytes || bytes.byteLength !== expectedBytes) return Response.json({ error: "snapshot_length_mismatch" }, { status: 400, headers });
      const actualHash = await sha256BytesHex(bytes);
      if (actualHash !== expectedHash.toLowerCase()) return Response.json({ error: "snapshot_hash_mismatch" }, { status: 422, headers });
      const objectKey = `accounts/${encodeURIComponent(accountID)}/workspaces/${encodeURIComponent(workspaceID)}/snapshots/${snapshotID.toUpperCase()}/${actualHash}.workbenchworkspace`;
      await env.ASSETS.put(objectKey, bytes, { customMetadata: { workspaceID, accountID, snapshotID: snapshotID.toUpperCase(), sha256: actualHash, byteCount: String(bytes.byteLength), filePath } });
      const createdAt = new Date().toISOString();
      await env.DB.prepare("INSERT INTO cloud_snapshots (workspace_id, account_id, snapshot_id, subject, file_path, content_hash, byte_count, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(workspaceID, accountID, snapshotID.toUpperCase(), claims.sub, filePath, actualHash, bytes.byteLength, objectKey, createdAt).run();
      return Response.json({ created: true, path: filePath, sha256: actualHash, byteCount: bytes.byteLength, createdAt }, { status: 201, headers });
    }

    if (workspaceMatch?.[2] === "devices" && request.method === "POST") {
      if (membership.role === "viewer") return Response.json({ error: "forbidden" }, { status: 403, headers });
      const body = await readJson(request, 8192);
      if (!body || typeof body.id !== "string" || !isUUID(body.id) || typeof body.name !== "string" || !body.name.trim() ||
          typeof body.kind !== "string" || !["web", "android", "ios", "macos"].includes(body.kind) ||
          typeof body.publicKey !== "string" || body.publicKey.length < 32 || body.publicKey.length > 4096) {
        return Response.json({ error: "invalid_device" }, { status: 400, headers });
      }
      const existing = await env.DB.prepare("SELECT subject, name, kind, public_key, revoked_at FROM devices WHERE workspace_id = ? AND account_id = ? AND id = ?").bind(workspaceID, accountID, body.id).first<{ subject: string; name: string; kind: string; public_key: string; revoked_at: string | null }>();
      if (existing && existing.subject !== claims.sub) return Response.json({ error: "device_id_conflict" }, { status: 409, headers });
      if (existing?.revoked_at) return Response.json({ error: "device_revoked" }, { status: 403, headers });
      if (existing) {
        if (existing.name !== body.name.trim() || existing.kind !== body.kind || existing.public_key !== body.publicKey) return Response.json({ error: "device_id_already_enrolled" }, { status: 409, headers });
        return Response.json({ id: body.id, revoked: false, enrolled: true }, { headers });
      }
      await env.DB.prepare(
        "INSERT INTO devices (workspace_id, account_id, id, name, subject, kind, public_key, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(workspaceID, accountID, body.id, body.name.trim(), claims.sub, body.kind, body.publicKey, new Date().toISOString()).run();
      return Response.json({ id: body.id, revoked: false }, { status: 201, headers });
    }
    if (deviceRevokeMatch && request.method === "POST") {
      if (membership.role !== "owner") return Response.json({ error: "forbidden" }, { status: 403, headers });
      const deviceID = decodeURIComponent(deviceRevokeMatch[2]);
      const result = await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE workspace_id = ? AND account_id = ? AND id = ? AND revoked_at IS NULL")
        .bind(new Date().toISOString(), workspaceID, accountID, deviceID).run();
      if (!result.meta.changes) return Response.json({ error: "device_not_found" }, { status: 404, headers });
      return Response.json({ id: deviceID, revoked: true }, { headers });
    }

    if (assetMatch && request.method === "POST" && !assetMatch[3]) {
      if (membership.role === "viewer" || !env.ASSETS) return Response.json({ error: "forbidden" }, { status: 403, headers });
      const deviceID = request.headers.get("x-workbench-device-id");
      if (!deviceID) return Response.json({ error: "device_required" }, { status: 400, headers });
      const device = await env.DB.prepare("SELECT id FROM devices WHERE workspace_id = ? AND account_id = ? AND id = ? AND subject = ? AND revoked_at IS NULL").bind(workspaceID, accountID, deviceID, claims.sub).first();
      if (!device) return Response.json({ error: "device_not_authorized" }, { status: 403, headers });
      const manifest = await readJson(request, 512 * 1024);
      if (!manifest || manifest.id !== decodeURIComponent(assetMatch[2])) return Response.json({ error: "invalid_asset_manifest" }, { status: 400, headers });
      try {
        await initializeAssetUpload(env as Env & { DB: D1Database; ASSETS: R2Bucket }, { subject: claims.sub, accountID, workspaceID, deviceID }, manifest);
        return Response.json({ initialized: true }, { status: 201, headers });
      } catch (error) { return Response.json({ error: "invalid_asset_manifest", message: String(error) }, { status: 400, headers }); }
    }

    if (assetMatch && assetMatch[3] === "chunks" && request.method === "PUT") {
      if (membership.role === "viewer" || !env.ASSETS) return Response.json({ error: "forbidden" }, { status: 403, headers });
      const deviceID = request.headers.get("x-workbench-device-id");
      if (!deviceID) return Response.json({ error: "device_required" }, { status: 400, headers });
      const device = await env.DB.prepare("SELECT id FROM devices WHERE workspace_id = ? AND account_id = ? AND id = ? AND subject = ? AND revoked_at IS NULL")
        .bind(workspaceID, accountID, deviceID, claims.sub).first();
      if (!device) return Response.json({ error: "device_not_authorized" }, { status: 403, headers });
      const upload = await env.DB.prepare("SELECT manifest_json FROM asset_uploads WHERE workspace_id = ? AND account_id = ? AND asset_id = ? AND subject = ?")
        .bind(workspaceID, accountID, decodeURIComponent(assetMatch[2]), claims.sub).first<{ manifest_json: string }>();
      if (!upload) return Response.json({ error: "asset_upload_not_initialized" }, { status: 404, headers });
      const manifest = JSON.parse(upload.manifest_json);
      const offset = Number(new URL(request.url).searchParams.get("offset"));
      const raw = await readBytes(request, 8 * 1024 * 1024);
      if (!raw) return Response.json({ error: "chunk_too_large" }, { status: 413, headers });
      try {
        const progress = await putAssetChunk(env as Env & { DB: D1Database; ASSETS: R2Bucket }, { subject: claims.sub, accountID, workspaceID, deviceID }, manifest, offset, raw);
        return Response.json(progress, { headers });
      } catch (error) {
        return Response.json({ error: "invalid_asset_chunk", message: String(error) }, { status: 400, headers });
      }
    }

    if (resource === "cursor" && request.method === "GET") {
      const row = await env.DB.prepare("SELECT cursor FROM workspaces WHERE id = ? AND account_id = ?").bind(workspaceID, accountID).first<{ cursor: number }>();
      if (!row) return Response.json({ error: "not_found" }, { status: 404, headers });
      return Response.json({ workspaceID, sequence: row.cursor }, { headers });
    }
    if (resource === "mutations" && request.method === "GET") {
      const deviceID = request.headers.get("x-workbench-device-id");
      if (!deviceID) return Response.json({ error: "device_required" }, { status: 400, headers });
      const device = await env.DB.prepare(
        "SELECT id FROM devices WHERE workspace_id = ? AND account_id = ? AND id = ? AND subject = ? AND revoked_at IS NULL",
      ).bind(workspaceID, accountID, deviceID, claims.sub).first();
      if (!device) return Response.json({ error: "device_not_authorized" }, { status: 403, headers });
      const after = boundedInteger(new URL(request.url).searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
      const limit = boundedInteger(new URL(request.url).searchParams.get("limit"), 100, 500);
      const result = await env.DB.prepare(
        "SELECT sequence, record_json AS record, outcome FROM mutations WHERE workspace_id = ? AND account_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      ).bind(workspaceID, accountID, after, limit).all<{ sequence: number; record: string; outcome: string }>();
      const next = result.results.at(-1)?.sequence ?? after;
      const head = await env.DB.prepare("SELECT cursor FROM workspaces WHERE id = ? AND account_id = ?").bind(workspaceID, accountID).first<{ cursor: number }>();
      return Response.json({ workspaceID, changes: result.results.map((row) => ({ sequence: row.sequence, record: JSON.parse(row.record), outcome: row.outcome })), nextCursor: next, hasMore: next < (head?.cursor ?? next) }, { headers });
    }
    if (resource === "acknowledgements" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT device_id AS deviceID, sequence, updated_at AS updatedAt FROM acknowledgements WHERE workspace_id = ? AND account_id = ? ORDER BY device_id",
      ).bind(workspaceID, accountID).all<{ deviceID: string; sequence: number; updatedAt: string }>();
      return Response.json({ acknowledgements: rows.results }, { headers });
    }
    if (resource === "conflicts" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id, entity_kind AS entityKind, record_id AS recordID, local_record_json AS localRecord, remote_record_json AS remoteRecord, created_at AS createdAt FROM conflicts WHERE workspace_id = ? AND account_id = ? ORDER BY created_at, id LIMIT 500",
      ).bind(workspaceID, accountID).all<{ id: string; entityKind: string; recordID: string; localRecord: string; remoteRecord: string; createdAt: string }>();
      return Response.json({ conflicts: rows.results.map((row) => ({ id: row.id, entityKind: row.entityKind, recordID: row.recordID, local: JSON.parse(row.localRecord), remote: JSON.parse(row.remoteRecord), createdAt: row.createdAt })) }, { headers });
    }
    if (resource === "acknowledgements" && request.method === "POST") {
      if (membership.role === "viewer") return Response.json({ error: "forbidden" }, { status: 403, headers });
      const deviceID = request.headers.get("x-workbench-device-id");
      if (!deviceID) return Response.json({ error: "device_required" }, { status: 400, headers });
      const device = await env.DB.prepare(
        "SELECT id FROM devices WHERE workspace_id = ? AND account_id = ? AND id = ? AND subject = ? AND revoked_at IS NULL",
      ).bind(workspaceID, accountID, deviceID, claims.sub).first();
      if (!device) return Response.json({ error: "device_not_authorized" }, { status: 403, headers });
      const body = await readJson(request, 4096);
      if (!body || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 0) return Response.json({ error: "invalid_acknowledgement" }, { status: 400, headers });
      const cursor = await env.DB.prepare("SELECT cursor FROM workspaces WHERE id = ? AND account_id = ?").bind(workspaceID, accountID).first<{ cursor: number }>();
      if (!cursor || Number(body.sequence) > cursor.cursor) return Response.json({ error: "acknowledgement_ahead_of_cursor" }, { status: 409, headers });
      await env.DB.prepare(
        `INSERT INTO acknowledgements (workspace_id, account_id, device_id, subject, sequence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, account_id, device_id)
         DO UPDATE SET sequence = MAX(sequence, excluded.sequence), updated_at = excluded.updated_at`,
      ).bind(workspaceID, accountID, deviceID, claims.sub, Number(body.sequence), new Date().toISOString()).run();
      await env.DB.prepare("UPDATE devices SET last_acknowledged_sequence = MAX(last_acknowledged_sequence, ?), last_seen_at = ? WHERE workspace_id = ? AND account_id = ? AND id = ?")
        .bind(Number(body.sequence), new Date().toISOString(), workspaceID, accountID, deviceID).run();
      return Response.json({ acknowledged: Number(body.sequence) }, { headers });
    }
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...headers, Allow: resource === "cursor" || resource === "mutations" || resource === "conflicts" ? "GET" : resource === "acknowledgements" ? "GET, POST" : "POST" } });
}

function boundedInteger(value: string | null | undefined, fallback: number, max: number): number {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, max) : fallback;
}

function hasAccessOIDCConfig(env: Env): boolean {
  if (!env.AUTH_ISSUER || !env.AUTH_AUDIENCE || !env.AUTH_JWKS_URL || !env.AUTH_CLIENT_ID || env.AUTH_AUDIENCE !== env.AUTH_CLIENT_ID ||
      !env.AUTH_CLIENT_SECRET || !env.AUTH_AUTHORIZATION_URL || !env.AUTH_TOKEN_URL || !env.AUTH_REDIRECT_URIS) return false;
  try {
    const issuer = new URL(env.AUTH_ISSUER);
    const authorization = new URL(env.AUTH_AUTHORIZATION_URL);
    const token = new URL(env.AUTH_TOKEN_URL);
    const jwks = new URL(env.AUTH_JWKS_URL);
    return issuer.protocol === "https:" && issuer.hostname.endsWith(".cloudflareaccess.com") &&
      [authorization, token, jwks].every((url) => url.protocol === "https:" && url.origin === issuer.origin);
  } catch { return false; }
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return undefined;
  try {
    if (!request.body) return undefined;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes || !request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export type { IdentityClaims } from "./identity.js";
