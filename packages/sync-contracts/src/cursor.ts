/**
 * A cursor is the monotonic position in a workspace's change stream. Clients pull by
 * cursor; the server returns every record whose sequence number exceeds it. Cursors
 * are per-workspace and monotonically increasing. Sequence numbers come from the
 * mutation envelope, not stored on individual records (see envelope.ts).
 */
export interface Cursor {
  readonly workspaceID: string;
  /** Highest consumed sequence number (inclusive). */
  readonly sequence: number;
}

export function makeCursor(workspaceID: string, sequence: number): Cursor {
  return { workspaceID, sequence };
}

/** True when a sequence number is strictly greater than the cursor's. */
export function after(cursor: Cursor, sequence: number): boolean {
  return sequence > cursor.sequence;
}
