/**
 * Identity contracts: accounts, workspaces, and devices. The server validates
 * workspace identity, protocol version, schema version, asset paths, hashes,
 * limits, and authorization before persisting anything.
 */
import { CURRENT_SCHEMA_VERSION } from "./index.js";

export interface Account {
  readonly id: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Workspace {
  readonly id: string;
  readonly accountID: string;
  readonly name: string;
  /** Schema version this workspace was created with. */
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Feature flags enabled for this workspace (e.g. wiki, voice memos). */
  readonly featureFlags?: Record<string, boolean>;
}

export type DeviceKind = "web" | "android" | "ios" | "macos";

export interface Device {
  readonly id: string;
  /** Human-readable device name (e.g. "MacBook Pro", "iPhone"). */
  readonly name: string;
  readonly kind: DeviceKind;
  /** Ed25519 / ECDSA public key used to authenticate this device's mutations. */
  readonly publicKey: string;
  readonly isRevoked: boolean;
  /** Highest sequence acknowledged by this device. */
  readonly lastAcknowledgedSequence: number;
  readonly lastSeenAt?: string;
}

export function validateWorkspace(ws: unknown): asserts ws is Workspace {
  if (!ws || typeof ws !== "object") throw new TypeError("workspace must be an object");
  const w = ws as Record<string, unknown>;
  for (const key of ["id", "accountID", "name", "schemaVersion"]) {
    if (!(key in w)) throw new TypeError(`workspace missing field "${key}"`);
  }
  if (!w.id || typeof w.id !== "string") throw new TypeError("invalid workspace id");
  if (!w.accountID || typeof w.accountID !== "string") throw new TypeError("invalid accountID");
  if (typeof w.name !== "string" || w.name.length === 0) throw new TypeError("invalid name");
  const schemaVersion = Number(w.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < CURRENT_SCHEMA_VERSION) {
    throw new TypeError(`unsupported schemaVersion ${w.schemaVersion}`);
  }
}

export function validateDevice(device: unknown): asserts device is Device {
  if (!device || typeof device !== "object") throw new TypeError("device must be an object");
  const d = device as Record<string, unknown>;
  for (const key of ["id", "name", "kind", "publicKey", "isRevoked"]) {
    if (!(key in d)) throw new TypeError(`device missing field "${key}"`);
  }
  if (!d.id || typeof d.id !== "string") throw new TypeError("invalid device id");
  if (typeof d.name !== "string" || !d.name) throw new TypeError("invalid name");
  if (typeof d.kind !== "string" || !["web", "android", "ios", "macos"].includes(d.kind)) {
    throw new TypeError(`invalid device kind "${String(d.kind)}"`);
  }
  if (!d.publicKey || typeof d.publicKey !== "string") throw new TypeError("invalid publicKey");
  if (typeof d.isRevoked !== "boolean") throw new TypeError("invalid isRevoked");
}
