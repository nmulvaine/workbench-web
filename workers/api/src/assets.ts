import { validateAsset } from "../../../packages/sync-contracts/src/asset.js";
import type { AssetManifest } from "../../../packages/sync-contracts/src/asset.js";
import { canonicalJSON, sha256BytesHex } from "../../../packages/sync-contracts/src/record.js";

export interface AssetEnv { DB: D1Database; ASSETS: R2Bucket; MAX_ASSET_BYTES?: string }
export interface AssetPrincipal { subject: string; accountID: string; workspaceID: string; deviceID: string }

export interface DownloadableAsset {
  readonly body: ReadableStream;
  readonly byteCount: number;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly logicalPath: string;
}

export function assetObjectKey(accountID: string, workspaceID: string, contentHash: string): string {
  if (!/^[0-9a-f]{64}$/i.test(contentHash)) throw new TypeError("invalid content hash");
  return `accounts/${encodeURIComponent(accountID)}/workspaces/${encodeURIComponent(workspaceID)}/assets/${contentHash.toLowerCase()}`;
}

/** Return only a fully verified object owned by this account and workspace. */
export async function getVerifiedAsset(env: AssetEnv, principal: AssetPrincipal, assetID: string): Promise<DownloadableAsset | undefined> {
  const row = await env.DB.prepare(
    "SELECT content_hash, byte_count, media_type, logical_path, status FROM asset_uploads WHERE workspace_id = ? AND account_id = ? AND asset_id = ?",
  ).bind(principal.workspaceID, principal.accountID, assetID).first<{ content_hash: string; byte_count: number; media_type: string; logical_path: string; status: string }>();
  if (!row || row.status !== "verified") return undefined;
  const stored = await env.ASSETS.get(assetObjectKey(principal.accountID, principal.workspaceID, row.content_hash)) as {
    body: ReadableStream;
    size: number;
    customMetadata?: Record<string, string>;
  } | null;
  if (!stored || stored.size !== row.byte_count || stored.customMetadata?.workspaceID !== principal.workspaceID ||
      stored.customMetadata?.assetID !== assetID || stored.customMetadata?.contentHash !== row.content_hash ||
      stored.customMetadata?.logicalPath !== row.logical_path) {
    throw new Error("verified asset object is missing or its metadata does not match D1");
  }
  return { body: stored.body, byteCount: row.byte_count, contentHash: row.content_hash, mediaType: row.media_type, logicalPath: row.logical_path };
}

export async function initializeAssetUpload(env: AssetEnv, principal: AssetPrincipal, manifestValue: unknown): Promise<void> {
  validateAsset(manifestValue);
  const manifest = manifestValue as AssetManifest;
  const max = Number(env.MAX_ASSET_BYTES ?? 64 * 1024 * 1024);
  const chunkSize = manifest.chunkSize ?? 0;
  const chunks = Math.ceil(manifest.byteCount / chunkSize);
  if (!Number.isSafeInteger(manifest.byteCount) || manifest.byteCount <= 0 || manifest.byteCount > max) throw new RangeError("asset size outside configured limit");
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 64 * 1024 || chunkSize > 8 * 1024 * 1024 || chunks > 4096) throw new RangeError("chunk dimensions outside supported range");
  if (manifest.chunkHashes && manifest.chunkHashes.length !== chunks) throw new RangeError("chunk hash count does not match manifest");
  const existing = await env.DB.prepare("SELECT manifest_json, subject FROM asset_uploads WHERE workspace_id = ? AND account_id = ? AND asset_id = ?")
    .bind(principal.workspaceID, principal.accountID, manifest.id).first<{ manifest_json: string; subject: string }>();
  const json = canonicalJSON(manifest);
  if (existing && (existing.subject !== principal.subject || existing.manifest_json !== json)) throw new Error("asset ID is already bound to a different manifest or owner");
  await env.DB.prepare(
    `INSERT INTO asset_uploads (workspace_id, account_id, asset_id, subject, content_hash, manifest_json, byte_count, media_type, logical_path, chunk_size, chunk_count, completed_chunks_json, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'uploading', ?) ON CONFLICT (workspace_id, account_id, asset_id) DO NOTHING`,
  ).bind(principal.workspaceID, principal.accountID, manifest.id, principal.subject, manifest.contentHash, json, manifest.byteCount, manifest.mediaType, manifest.logicalPath, chunkSize, chunks, new Date().toISOString()).run();
}

/** Store one independently verified chunk and durable progress checkpoint. */
export async function putAssetChunk(
  env: AssetEnv,
  principal: AssetPrincipal,
  manifestValue: unknown,
  offset: number,
  bytes: Uint8Array,
): Promise<{ receivedChunks: number; totalChunks: number; complete: boolean }> {
  validateAsset(manifestValue);
  const manifest = manifestValue as AssetManifest;
  // The complete object is verified in memory before promotion; keep the safe
  // ceiling below the Workers memory budget until a streaming hash path is added.
  const max = Number(env.MAX_ASSET_BYTES ?? 64 * 1024 * 1024);
  if (!Number.isSafeInteger(manifest.byteCount) || manifest.byteCount > max || manifest.byteCount < 0) throw new RangeError("asset size outside configured limit");
  const chunkSize = manifest.chunkSize ?? 0;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 64 * 1024 || chunkSize > 8 * 1024 * 1024) throw new RangeError("chunk size outside supported range");
  const totalChunks = Math.ceil(manifest.byteCount / chunkSize);
  if (totalChunks === 0 || totalChunks > 4096) throw new RangeError("asset chunk count outside supported range");
  const index = offset / chunkSize;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % chunkSize !== 0 || index >= totalChunks) throw new RangeError("invalid chunk offset");
  const expectedLength = Math.min(chunkSize, manifest.byteCount - offset);
  if (bytes.byteLength !== expectedLength) throw new RangeError("invalid chunk length");
  const digest = await sha256BytesHex(bytes);
  const expectedDigest = manifest.chunkHashes?.[index];
  if (expectedDigest && digest.toLowerCase() !== expectedDigest.toLowerCase()) throw new Error("chunk hash mismatch");

  const upload = await env.DB.prepare(
    "SELECT completed_chunks_json, content_hash, manifest_json, byte_count, chunk_size FROM asset_uploads WHERE workspace_id = ? AND account_id = ? AND asset_id = ? AND subject = ?",
  ).bind(principal.workspaceID, principal.accountID, manifest.id, principal.subject).first<{ completed_chunks_json: string; content_hash: string; manifest_json: string; byte_count: number; chunk_size: number }>();
  if (!upload) throw new Error("asset upload is not initialized");
  if (upload.manifest_json !== canonicalJSON(manifest)) throw new Error("asset upload manifest mismatch");
  if (upload && (upload.content_hash !== manifest.contentHash || upload.byte_count !== manifest.byteCount || upload.chunk_size !== chunkSize)) throw new Error("asset upload manifest changed");
  await env.ASSETS.put(`${assetObjectKey(principal.accountID, principal.workspaceID, manifest.contentHash)}.parts/${index}`, bytes, {
    customMetadata: { workspaceID: principal.workspaceID, assetID: manifest.id, contentHash: manifest.contentHash, chunkIndex: String(index), chunkHash: digest },
  });
  const completed = new Set<number>(upload ? JSON.parse(upload.completed_chunks_json) as number[] : []);
  completed.add(index);
  const allPartsPresent = completed.size === totalChunks;
  if (allPartsPresent) {
    const parts: Uint8Array[] = [];
    for (let part = 0; part < totalChunks; part += 1) {
      const object = await env.ASSETS.get(`${assetObjectKey(principal.accountID, principal.workspaceID, manifest.contentHash)}.parts/${part}`);
      if (!object) throw new Error("asset checkpoint references missing chunk");
      parts.push(new Uint8Array(await object.arrayBuffer()));
    }
    const content = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let position = 0;
    for (const part of parts) { content.set(part, position); position += part.byteLength; }
    const fullDigest = await sha256BytesHex(content);
    if (fullDigest.toLowerCase() !== manifest.contentHash.toLowerCase()) throw new Error("asset hash mismatch");
    await env.ASSETS.put(assetObjectKey(principal.accountID, principal.workspaceID, manifest.contentHash), content, {
      httpMetadata: { contentType: manifest.mediaType },
      customMetadata: { workspaceID: principal.workspaceID, assetID: manifest.id, contentHash: manifest.contentHash, logicalPath: manifest.logicalPath },
    });
    await env.DB.prepare(
      `INSERT INTO asset_uploads (workspace_id, account_id, asset_id, subject, content_hash, manifest_json, byte_count, media_type, logical_path, chunk_size, chunk_count, completed_chunks_json, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?) ON CONFLICT (workspace_id, account_id, asset_id)
       DO UPDATE SET completed_chunks_json = excluded.completed_chunks_json, status = 'verified', updated_at = excluded.updated_at`,
    ).bind(principal.workspaceID, principal.accountID, manifest.id, principal.subject, manifest.contentHash, canonicalJSON(manifest), manifest.byteCount, manifest.mediaType, manifest.logicalPath, chunkSize, totalChunks, JSON.stringify([...completed].sort((a, b) => a - b)), new Date().toISOString()).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO asset_uploads (workspace_id, account_id, asset_id, subject, content_hash, manifest_json, byte_count, media_type, logical_path, chunk_size, chunk_count, completed_chunks_json, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?) ON CONFLICT (workspace_id, account_id, asset_id)
       DO UPDATE SET completed_chunks_json = excluded.completed_chunks_json, updated_at = excluded.updated_at`,
    ).bind(principal.workspaceID, principal.accountID, manifest.id, principal.subject, manifest.contentHash, canonicalJSON(manifest), manifest.byteCount, manifest.mediaType, manifest.logicalPath, chunkSize, totalChunks, JSON.stringify([...completed].sort((a, b) => a - b)), new Date().toISOString()).run();
  }
  return { receivedChunks: completed.size, totalChunks, complete: allPartsPresent };
}
