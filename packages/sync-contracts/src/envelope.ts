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
  readonly protocolVersion: number;
  readonly workspaceID: string;
  readonly senderDeviceID: string;
  /** Inclusive sequence range this envelope occupies in the change stream. */
  readonly sequenceStart: number;
  readonly sequenceEnd: number;
  readonly records: SyncableRecord[];
  readonly assets: AssetManifest[];
  readonly createdAt: string;
}

export function totalAssetBytes(envelope: ChangeEnvelope): number {
  return envelope.assets.reduce((sum, a) => sum + a.byteCount, 0);
}

/** Validate a received change envelope. Throws on violation. */
export function validateEnvelope(envelope: unknown): asserts envelope is ChangeEnvelope {
  if (!envelope || typeof envelope !== "object") throw new TypeError("envelope must be an object");
  const e = envelope as Record<string, unknown>;
  for (const key of ["protocolVersion", "workspaceID", "senderDeviceID", "sequenceStart", "sequenceEnd", "createdAt"]) {
    if (!(key in e)) throw new TypeError(`envelope missing field "${key}"`);
  }
  if (!Number.isInteger(e.protocolVersion) || e.protocolVersion !== CURRENT_PROTOCOL_VERSION) {
    throw new TypeError(`unsupported protocolVersion ${e.protocolVersion}`);
  }
  if (!e.workspaceID || typeof e.workspaceID !== "string") throw new TypeError("invalid workspaceID");
  if (!e.senderDeviceID || typeof e.senderDeviceID !== "string") throw new TypeError("invalid senderDeviceID");
  const sequenceStart = Number(e.sequenceStart);
  const sequenceEnd = Number(e.sequenceEnd);
  if (!Number.isInteger(sequenceStart) || !Number.isInteger(sequenceEnd)) {
    throw new TypeError("sequence range must be integers");
  }
  if (sequenceEnd < sequenceStart) throw new TypeError("sequenceEnd before sequenceStart");
  if (!Array.isArray(e.records)) throw new TypeError("records must be an array");
  if (!Array.isArray(e.assets)) throw new TypeError("assets must be an array");

  for (const record of e.records) validateRecord(record);
  for (const asset of e.assets) validateAsset(asset);
}
