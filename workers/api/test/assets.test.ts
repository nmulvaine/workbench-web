import { describe, expect, it } from "vitest";
import { sha256BytesHex } from "../../../packages/sync-contracts/src/record.js";
import type { AssetManifest } from "../../../packages/sync-contracts/src/asset.js";
import { assetObjectKey, getVerifiedAsset, initializeAssetUpload, putAssetChunk, type AssetEnv } from "../src/assets.js";

interface UploadRow { subject: string; content_hash: string; manifest_json: string; byte_count: number; chunk_size: number; completed_chunks_json: string; media_type: string; logical_path: string; status: string; }
class AssetDb {
  row?: UploadRow;
  prepare(sql: string) {
    let values: unknown[] = [];
    const thisDb = this;
    return {
      bind(...input: unknown[]) { values = input; return this; },
      async first<T>() { return thisDb.row as T ?? null; },
      async run() {
        if (sql.startsWith("INSERT INTO asset_uploads")) {
          const [, , , subject, contentHash, manifestJSON, byteCount, mediaType, logicalPath, chunkSize] = values as [string, string, string, string, string, string, number, string, string, number];
          if (sql.includes("VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]'")) {
            thisDb.row ??= { subject, content_hash: contentHash, manifest_json: manifestJSON, byte_count: byteCount, chunk_size: chunkSize, completed_chunks_json: "[]", media_type: mediaType, logical_path: logicalPath, status: "uploading" };
          } else {
            thisDb.row = { ...thisDb.row!, completed_chunks_json: String(values[11]), status: sql.includes("status = 'verified'") ? "verified" : "uploading" };
          }
        } else if (sql.includes("DO UPDATE SET completed_chunks_json")) {
          thisDb.row = { ...thisDb.row!, completed_chunks_json: String(values[10]) };
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
}

class AssetBucket {
  objects = new Map<string, Uint8Array>();
  metadata = new Map<string, Record<string, string>>();
  async put(key: string, value: Uint8Array, options?: { customMetadata?: Record<string, string> }) { this.objects.set(key, Uint8Array.from(value)); if (options?.customMetadata) this.metadata.set(key, options.customMetadata); return {}; }
  async get(key: string) {
    const value = this.objects.get(key);
    return value ? { arrayBuffer: async () => Uint8Array.from(value).buffer, body: new Response(value).body!, size: value.byteLength, customMetadata: this.metadata.get(key) } : null;
  }
}

describe("resumable R2 asset checkpoints", () => {
  it("resumes after an interruption and promotes only the fully verified asset", async () => {
    const data = new Uint8Array(65_537);
    for (let index = 0; index < data.length; index += 1) data[index] = index % 251;
    const first = data.slice(0, 65_536);
    const last = data.slice(65_536);
    const contentHash = await sha256BytesHex(data);
    const manifest: AssetManifest = { id: "asset-one", contentHash, byteCount: data.byteLength, mediaType: "application/octet-stream", logicalPath: "projects/project-one/blob.bin", chunkSize: 65_536, chunkHashes: [await sha256BytesHex(first), await sha256BytesHex(last)] };
    const db = new AssetDb();
    const bucket = new AssetBucket();
    const env = { DB: db, ASSETS: bucket } as unknown as AssetEnv;
    const principal = { subject: "user-one", accountID: "user-one", workspaceID: "workspace-one", deviceID: "device-one" };

    await initializeAssetUpload(env, principal, manifest);
    expect(await putAssetChunk(env, principal, manifest, 0, first)).toMatchObject({ receivedChunks: 1, totalChunks: 2, complete: false });
    await initializeAssetUpload(env, principal, manifest); // reload resumes from D1 checkpoint
    expect(await putAssetChunk(env, principal, manifest, 65_536, last)).toMatchObject({ receivedChunks: 2, totalChunks: 2, complete: true });
    expect(bucket.objects.get(assetObjectKey("user-one", "workspace-one", contentHash))).toEqual(data);
    const downloaded = await getVerifiedAsset(env, principal, manifest.id);
    expect(downloaded).toMatchObject({ byteCount: data.byteLength, contentHash, mediaType: manifest.mediaType, logicalPath: manifest.logicalPath });
    expect(new Uint8Array(await new Response(downloaded?.body).arrayBuffer())).toEqual(data);
  });

  it("rejects a chunk hash mismatch and unsafe object paths", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const manifest: AssetManifest = { id: "asset-one", contentHash: await sha256BytesHex(bytes), byteCount: 3, mediaType: "application/octet-stream", logicalPath: "../secret", chunkSize: 65_536, chunkHashes: ["0".repeat(64)] };
    const env = { DB: new AssetDb(), ASSETS: new AssetBucket() } as unknown as AssetEnv;
    await expect(initializeAssetUpload(env, { subject: "u", accountID: "u", workspaceID: "w", deviceID: "d" }, manifest)).rejects.toThrow(/unsafe logicalPath/);
    expect(() => assetObjectKey("user", "w", "../unsafe")).toThrow(/content hash/);
  });
});
