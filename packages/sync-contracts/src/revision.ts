/**
 * Structured revisions identify the version of a record on a given origin device.
 * A revision is `(counter, originDeviceID)`. Ordering is lexicographic by counter
 * first, then by origin device id — matching the native SyncRevision semantics so
 * that every platform agrees on which change "wins" when there is no conflict.
 */
export interface Revision {
  /** Monotonic per-device version counter. */
  readonly counter: number;
  /** The UUID of the device that produced this revision. */
  readonly originDeviceID: string;
}

export function makeRevision(counter: number, originDeviceID: string): Revision {
  return { counter, originDeviceID };
}

export function revisionKey(revision: Revision): string {
  return `${revision.counter}:${revision.originDeviceID}`;
}

export function revisionsEqual(a: Revision, b: Revision): boolean {
  return a.counter === b.counter && a.originDeviceID === b.originDeviceID;
}

export function revisionGreater(a: Revision, b: Revision): boolean {
  if (a.counter !== b.counter) return a.counter > b.counter;
  return a.originDeviceID > b.originDeviceID;
}
