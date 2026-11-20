import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * A workstream groups the sessions working on one feature, bug or investigation. Sessions keep
 * their own project, belong to one workstream at most, and share the workstream's memory.
 */
export const WorkstreamId = TrimmedNonEmptyString.pipe(Schema.brand("WorkstreamId"));
export type WorkstreamId = typeof WorkstreamId.Type;

export const WorkstreamMemoryEntryId = TrimmedNonEmptyString.pipe(
  Schema.brand("WorkstreamMemoryEntryId"),
);
export type WorkstreamMemoryEntryId = typeof WorkstreamMemoryEntryId.Type;

export const WORKSTREAM_MEMORY_DEFAULT_BUDGET_CHARS = 6_000;
export const WORKSTREAM_MEMORY_MIN_BUDGET_CHARS = 1_000;
export const WORKSTREAM_MEMORY_MAX_BUDGET_CHARS = 24_000;
export const WORKSTREAM_MEMORY_ENTRY_MAX_CHARS = 600;
export const WORKSTREAM_MEMORY_DEFAULT_GATE_THRESHOLD = 0.3;

const BudgetChars = Schema.Int.check(
  Schema.isBetween({
    minimum: WORKSTREAM_MEMORY_MIN_BUDGET_CHARS,
    maximum: WORKSTREAM_MEMORY_MAX_BUDGET_CHARS,
  }),
);
const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const EntryText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(WORKSTREAM_MEMORY_ENTRY_MAX_CHARS),
);

export const WorkstreamMemorySettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** The user's own words on what is worth remembering; empty uses the built-in guidance. */
  instructions: Schema.String,
  /** Entries past this total are merged down by the next memory update. */
  budgetChars: BudgetChars,
});
export type WorkstreamMemorySettings = typeof WorkstreamMemorySettings.Type;

export const WORKSTREAM_ICONS = [
  "rocket",
  "bug",
  "flask",
  "wrench",
  "compass",
  "star",
  "shield",
  "database",
  "globe",
  "terminal",
  "zap",
  "package",
  "map",
  "target",
  "book",
  "flag",
  "lightbulb",
  "puzzle",
  "anchor",
  "leaf",
  "flame",
  "key",
  "telescope",
  "server",
] as const;
export const WorkstreamIcon = Schema.Literals(WORKSTREAM_ICONS);
export type WorkstreamIcon = typeof WorkstreamIcon.Type;

export const WORKSTREAM_COLORS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "purple",
  "pink",
  "gray",
] as const;
export const WorkstreamColor = Schema.Literals(WORKSTREAM_COLORS);
export type WorkstreamColor = typeof WorkstreamColor.Type;

/** The icon and color a workstream shows until the user picks: stable per id, spread across ids. */
export function defaultWorkstreamAppearance(id: string): {
  readonly icon: WorkstreamIcon;
  readonly color: WorkstreamColor;
} {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  }
  return {
    icon: WORKSTREAM_ICONS[hash % WORKSTREAM_ICONS.length]!,
    color: WORKSTREAM_COLORS[(hash >>> 8) % WORKSTREAM_COLORS.length]!,
  };
}

export const Workstream = Schema.Struct({
  id: WorkstreamId,
  name: TrimmedNonEmptyString,
  /** A visual marker shown before the name; it carries no meaning. */
  icon: WorkstreamIcon,
  color: WorkstreamColor,
  /** Fractional key for the manual order. */
  orderKey: Schema.String,
  /** Project a new session in this workstream starts in. Null falls back to the client default. */
  defaultProjectId: Schema.NullOr(ProjectId),
  memory: WorkstreamMemorySettings,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Workstream = typeof Workstream.Type;

export const WorkstreamMembership = Schema.Struct({
  threadId: ThreadId,
  workstreamId: WorkstreamId,
  pinnedAt: Schema.NullOr(IsoDateTime),
  /** Fractional key ordering pinned sessions inside their workstream. */
  pinOrderKey: Schema.NullOr(Schema.String),
});
export type WorkstreamMembership = typeof WorkstreamMembership.Type;

/** Server-wide memory settings, shared by every workstream on this environment. */
export const WorkstreamMemoryConfig = Schema.Struct({
  /** Ask the OpenAI Decisions API whether a turn is worth remembering before merging it. */
  gateEnabled: Schema.Boolean,
  /** A turn passes the gate at or above this probability. */
  gateThreshold: Probability,
  /** Whether an OpenAI API key is stored. The key itself never leaves the server. */
  gateKeyConfigured: Schema.Boolean,
  /** Model for the merge call. Null uses the text generation model. */
  mergeModelSelection: Schema.NullOr(ModelSelection),
});
export type WorkstreamMemoryConfig = typeof WorkstreamMemoryConfig.Type;

export const WorkstreamState = Schema.Struct({
  workstreams: ForwardCompatibleArray(Workstream),
  memberships: ForwardCompatibleArray(WorkstreamMembership),
  memoryConfig: WorkstreamMemoryConfig,
});
export type WorkstreamState = typeof WorkstreamState.Type;

export const WorkstreamSubscribeInput = Schema.Struct({});
export type WorkstreamSubscribeInput = typeof WorkstreamSubscribeInput.Type;

export const WorkstreamMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("workstream.create"),
    name: TrimmedNonEmptyString,
    defaultProjectId: Schema.optional(Schema.NullOr(ProjectId)),
  }),
  Schema.Struct({
    type: Schema.Literal("workstream.update"),
    workstreamId: WorkstreamId,
    name: Schema.optional(TrimmedNonEmptyString),
    icon: Schema.optional(WorkstreamIcon),
    color: Schema.optional(WorkstreamColor),
    defaultProjectId: Schema.optional(Schema.NullOr(ProjectId)),
    orderKey: Schema.optional(Schema.String),
    memoryEnabled: Schema.optional(Schema.Boolean),
    memoryInstructions: Schema.optional(Schema.String),
    memoryBudgetChars: Schema.optional(BudgetChars),
  }),
  /** Sessions of a deleted workstream become unsorted; its memory is deleted with it. */
  Schema.Struct({ type: Schema.Literal("workstream.delete"), workstreamId: WorkstreamId }),
  /** Null moves the session out of every workstream. Moving clears its pin. */
  Schema.Struct({
    type: Schema.Literal("thread.assign"),
    threadId: ThreadId,
    workstreamId: Schema.NullOr(WorkstreamId),
  }),
  /** Pinning a pinned session with a new key reorders it. */
  Schema.Struct({
    type: Schema.Literal("thread.pin"),
    threadId: ThreadId,
    pinned: Schema.Boolean,
    orderKey: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("memory-config.update"),
    gateEnabled: Schema.optional(Schema.Boolean),
    gateThreshold: Schema.optional(Probability),
    /** Null removes the stored key. */
    gateApiKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    mergeModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  }),
]);
export type WorkstreamMutation = typeof WorkstreamMutation.Type;

export const WorkstreamMutationResult = Schema.Struct({
  /** The workstream a create made. */
  workstreamId: Schema.optional(WorkstreamId),
});
export type WorkstreamMutationResult = typeof WorkstreamMutationResult.Type;

export const WorkstreamMemoryEntryKind = Schema.Literals([
  "decision",
  "convention",
  "fact",
  "open_item",
]);
export type WorkstreamMemoryEntryKind = typeof WorkstreamMemoryEntryKind.Type;

export const WorkstreamMemoryEntry = Schema.Struct({
  id: WorkstreamMemoryEntryId,
  workstreamId: WorkstreamId,
  kind: WorkstreamMemoryEntryKind,
  text: Schema.String,
  /** The session whose turn produced the entry. Null for entries the user wrote. */
  sourceThreadId: Schema.NullOr(ThreadId),
  /** Locked entries are never changed or removed by automatic updates. */
  locked: Schema.Boolean,
  /** The workstream memory revision that last wrote this entry. */
  revision: Schema.Int,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkstreamMemoryEntry = typeof WorkstreamMemoryEntry.Type;

export const WorkstreamMemorySubscribeInput = Schema.Struct({ workstreamId: WorkstreamId });
export type WorkstreamMemorySubscribeInput = typeof WorkstreamMemorySubscribeInput.Type;

export const WorkstreamMemoryState = Schema.Struct({
  entries: ForwardCompatibleArray(WorkstreamMemoryEntry),
});
export type WorkstreamMemoryState = typeof WorkstreamMemoryState.Type;

export const WorkstreamMemoryMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("entry.add"),
    workstreamId: WorkstreamId,
    kind: WorkstreamMemoryEntryKind,
    text: EntryText,
    locked: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("entry.update"),
    entryId: WorkstreamMemoryEntryId,
    kind: Schema.optional(WorkstreamMemoryEntryKind),
    text: Schema.optional(EntryText),
    locked: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("entry.delete"), entryId: WorkstreamMemoryEntryId }),
  /** Removes every entry, locked ones included. */
  Schema.Struct({ type: Schema.Literal("memory.clear"), workstreamId: WorkstreamId }),
]);
export type WorkstreamMemoryMutation = typeof WorkstreamMemoryMutation.Type;

export class WorkstreamError extends Schema.TaggedError<WorkstreamError>()("WorkstreamError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
