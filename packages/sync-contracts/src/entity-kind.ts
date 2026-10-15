/**
 * Platform-neutral Workbench Sync Protocol v1 contract types.
 *
 * These are the canonical, wire-format-agnostic definitions shared by every
 * client (web, Android, iOS, macOS) and the Cloudflare server adapter. The web
 * service must NOT invent a separate wire format; it reuses these contracts so
 * that record hashes, asset paths, revisions, tombstones, conflicts, cursors,
 * and acknowledgements interoperate across all platforms.
 */

export type UUID = string;

/** Protocol version implemented by this contract set. Bump on incompatible changes. */
export const CURRENT_PROTOCOL_VERSION = 1 as const;

/** Current workspace schema version understood by the web client/server adapter. */
export const CURRENT_SCHEMA_VERSION = 3 as const;

/**
 * Entity kinds that participate in sync. AI-only kinds (analysis, brainstormTurn,
 * training*, checkpoint, adapter, evaluation, hat) are intentionally excluded here
 * and remain capability-gated / local only on every platform.
 */
export enum EntityKind {
  // System-managed records (server authored, never user-authored mutations).
  Account = "account",
  Workspace = "workspace",
  Device = "device",

  // User-authored content that syncs across platforms.
  Project = "project",
  Idea = "idea", // free-form thoughts / captures
  Task = "task",
  Note = "note", // standalone notes
  BoardItem = "boardItem", // canvas sticky/board items (note/sketch/photo/brainstorm)
  Drawing = "drawing", // freehand drawings
  Photo = "photo", // photos / media attachments
  VoiceMemo = "voiceMemo", // voice memo metadata + playback pointer

  // Wiki vault content.
  WikiNotebook = "wikiNotebook",
  WikiPage = "wikiPage",
  WikiSource = "wikiSource",
  SourceChunk = "sourceChunk",
  Citation = "citation",

  // AI-only kinds (never sync; capability-gated, local only).
  Analysis = "analysis",
  BrainstormTurn = "brainstormTurn",
  TrainingDataset = "trainingDataset",
  TrainingExample = "trainingExample",
  TrainingRun = "trainingRun",
  Checkpoint = "checkpoint",
  Adapter = "adapter",
  Evaluation = "evaluation",
  Hat = "hat",
}

/** Kinds for which concurrent text edits are preserved as conflict copies rather than overwritten. */
export const AI_ONLY_KINDS: ReadonlySet<EntityKind> = new Set([
  EntityKind.Analysis,
  EntityKind.BrainstormTurn,
  EntityKind.TrainingDataset,
  EntityKind.TrainingExample,
  EntityKind.TrainingRun,
  EntityKind.Checkpoint,
  EntityKind.Adapter,
  EntityKind.Evaluation,
  EntityKind.Hat,
]);

export const TEXT_BEARING_KINDS: ReadonlySet<EntityKind> = new Set([
  EntityKind.Idea,
  EntityKind.Project,
  EntityKind.Note,
  EntityKind.BoardItem,
  EntityKind.WikiPage,
]);

/** Whether a kind supports conflict-aware concurrent text edit preservation. */
export function preservesConcurrentTextEdits(kind: EntityKind): boolean {
  return TEXT_BEARING_KINDS.has(kind);
}

/** Whether a kind is allowed to sync at all (excludes AI-only kinds). */
export function isSyncableKind(kind: EntityKind): boolean {
  if (!Object.values(EntityKind).includes(kind)) return false;
  return !AI_ONLY_KINDS.has(kind);
}
