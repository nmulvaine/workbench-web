/**
 * Assets are user-owned binary payloads (photos, drawings, audio). They sync only
 * after complete SHA-256 verification through resumable R2 sessions and are exposed
 * to clients exclusively once the hash matches. The manifest is content-addressed.
 */
import { sha256Hex } from "./record.js";

export interface AssetManifest {
  readonly id: string;
  /** Owner record id (nil on legacy manifests that used `id`). */
  readonly ownerRecordID?: string;
  /** Content hash of the full asset. Must match before exposure. */
  readonly contentHash: string;
  readonly byteCount: number;
  readonly mediaType: string; // e.g. "image/png", "audio/mpeg"
  /** Logical path within the workspace (e.g. "projects/123/photos/photo-uuid.png"). */
  readonly logicalPath: string;
  /** Chunk size in bytes for resumable uploads. */
  readonly chunkSize?: number;
  /** Per-chunk hashes, ordered by offset. */
  readonly chunkHashes?: string[];
  readonly [unknownField: string]: unknown;
}

export function assetMutationID(manifest: AssetManifest): string {
  return `asset:${manifest.id}`;
}

/** Content hash of the manifest itself (stable across platforms). */
export async function hashAssetManifest(manifest: AssetManifest): Promise<string> {
  return sha256Hex(JSON.stringify({ id: manifest.id, contentHash: manifest.contentHash, byteCount: manifest.byteCount }));
}

/** Validate a received asset manifest. Throws on violation. */
export function validateAsset(manifest: unknown): asserts manifest is AssetManifest {
  if (!manifest || typeof manifest !== "object") throw new TypeError("asset must be an object");
  const m = manifest as Record<string, unknown>;
  for (const key of ["id", "contentHash", "byteCount", "mediaType", "logicalPath"]) {
    if (!(key in m)) throw new TypeError(`asset missing field "${key}"`);
  }
  if (!m.id || typeof m.id !== "string") throw new TypeError("invalid asset id");
  if (typeof m.contentHash !== "string" || !/^[0-9a-f]{64}$/i.test(m.contentHash)) throw new TypeError("invalid contentHash");
  const byteCount = Number(m.byteCount);
  if (!Number.isSafeInteger(byteCount) || byteCount < 0) throw new TypeError("invalid byteCount");
  if (typeof m.mediaType !== "string") throw new TypeError("invalid mediaType");
  if (/[\r\n]/.test(m.mediaType)) throw new TypeError("invalid mediaType");
  if (typeof m.logicalPath !== "string" || !m.logicalPath) throw new TypeError("invalid logicalPath");
  if (m.ownerRecordID !== undefined && typeof m.ownerRecordID !== "string") throw new TypeError("invalid ownerRecordID");
  if (m.chunkSize !== undefined && (!Number.isSafeInteger(m.chunkSize) || Number(m.chunkSize) < 0)) throw new TypeError("invalid chunkSize");
  if (m.chunkHashes !== undefined && (!Array.isArray(m.chunkHashes) || m.chunkHashes.some((hash) => typeof hash !== "string"))) {
    throw new TypeError("chunkHashes must be an array of strings");
  }
  const path = m.logicalPath as string;
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new TypeError("unsafe logicalPath");
  }
}
