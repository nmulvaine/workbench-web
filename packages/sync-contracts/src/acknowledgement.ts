/**
 * Acknowledgements let trusted clients prune tombstones. The server retains a
 * tombstone until at least one trusted peer acknowledges having applied it; once
 * acknowledged by enough peers, the tombstone may be compacted.
 */
export interface Acknowledgement {
  readonly peerID: string;
  /** Highest sequence this peer has acknowledged (inclusive). */
  readonly sequence: number;
  readonly timestamp: string;
}

/** Whether an acknowledgement covers a given record's sequence. */
export function acknowledgementCovers(ack: Acknowledgement, sequence: number): boolean {
  return sequence <= ack.sequence;
}
