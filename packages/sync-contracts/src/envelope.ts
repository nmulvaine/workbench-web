/**
 * The change envelope is the wire unit sent between clients and the server: a batch
 * of records plus their assets, tagged with a sequence range and sender identity. It
 * mirrors the native WorkspaceChangeEnvelope so every platform shares one format.
 */
import { CURRENT_PROTOCOL_VERSION } from "./index.js";
import { validateAsset } from "./asset.js";
import type { AssetManifest } from "./asset.js";
import { validateRecord } from "./record.js";
import type { SyncableRecord } from "./record.js";

export interface ChangeEnvelope {
  readonly id: string;
  readonly protocolVersion: number;
  readonly workspaceID: string;
  readonly senderDeviceID: string;
  /** Inclusive sequence range this envelope occupies in the change stream. */
  readonly sequenceStart: number;
  readonly sequenceEnd: number;
  readonly records: SyncableRecord[];
  readonly assets: AssetManifest[];
  readonly createdAt: string;
  /** Unknown envelope fields are retained by the Rust protocol representation. */
  readonly [unknownField: string]: unknown;
}

export const WORKBENCH_WORKSPACE_ID = "574F524B-4245-4E43-4853-594E43000001";

export function totalAssetBytes(envelope: ChangeEnvelope): number {
  return envelope.assets.reduce((sum, a) => sum + a.byteCount, 0);
}

/** Validate a received change envelope. Throws on violation. */
export function validateEnvelope(envelope: unknown): asserts envelope is ChangeEnvelope {
  if (!envelope || typeof envelope !== "object") throw new TypeError("envelope must be an object");
  const e = envelope as Record<string, unknown>;
  for (const key of ["id", "protocolVersion", "workspaceID", "senderDeviceID", "sequenceStart", "sequenceEnd", "createdAt"]) {
    if (!(key in e)) throw new TypeError(`envelope missing field "${key}"`);
  }
  if (!Number.isInteger(e.protocolVersion) || e.protocolVersion !== CURRENT_PROTOCOL_VERSION) {
    throw new TypeError(`unsupported protocolVersion ${e.protocolVersion}`);
  }
  if (typeof e.id !== "string" || !e.id) throw new TypeError("invalid envelope id");
  if (e.workspaceID !== WORKBENCH_WORKSPACE_ID) throw new TypeError("workspace identity does not match Workbench");
  if (!e.senderDeviceID || typeof e.senderDeviceID !== "string") throw new TypeError("invalid senderDeviceID");
  const sequenceStart = Number(e.sequenceStart);
  const sequenceEnd = Number(e.sequenceEnd);
  if (!Number.isSafeInteger(sequenceStart) || !Number.isSafeInteger(sequenceEnd) || sequenceStart < 0 || sequenceEnd < 0) {
    throw new TypeError("sequence range must be integers");
  }
  if (sequenceEnd < sequenceStart) throw new TypeError("sequenceEnd before sequenceStart");
  if (!Array.isArray(e.records)) throw new TypeError("records must be an array");
  if (!Array.isArray(e.assets)) throw new TypeError("assets must be an array");

  for (const record of e.records) validateRecord(record);
  for (const asset of e.assets) validateAsset(asset);
}
