import {
  defaultWorkstreamAppearance,
  ModelSelection,
  type ProjectId,
  type ThreadId,
  type Workstream,
  WorkstreamColor,
  WorkstreamIcon,
  type WorkstreamId,
  type WorkstreamMembership,
  type WorkstreamMemoryEntry,
  type WorkstreamMemoryEntryId,
  type WorkstreamMemoryEntryKind,
  WORKSTREAM_MEMORY_DEFAULT_GATE_THRESHOLD,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

interface WorkstreamRow {
  readonly workstream_id: WorkstreamId;
  readonly name: string;
  readonly order_key: string;
  readonly default_project_id: ProjectId | null;
  readonly icon: string | null;
  readonly color: string | null;
  readonly memory_enabled: number;
  readonly memory_instructions: string;
  readonly memory_budget_chars: number;
  readonly memory_revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface WorkstreamReadRow extends WorkstreamRow {
  readonly removed_revision: number | null;
}

interface ThreadRow {
  readonly thread_id: ThreadId;
  readonly workstream_id: WorkstreamId;
  readonly pinned_at: string | null;
  readonly pin_order_key: string | null;
  readonly memory_run_id: string | null;
  readonly memory_run_ordinal: number;
  readonly delivered_provider_thread_id: string | null;
  readonly delivered_revision: number;
}

interface EntryRow {
  readonly entry_id: WorkstreamMemoryEntryId;
  readonly workstream_id: WorkstreamId;
  readonly kind: WorkstreamMemoryEntryKind;
  readonly text: string;
  readonly source_thread_id: ThreadId | null;
  readonly locked: number;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ConfigRow {
  readonly gate_enabled: number;
  readonly gate_threshold: number;
  readonly merge_model_selection_json: string | null;
}

export interface WorkstreamRecord extends Workstream {
  /** Bumped by every memory write; entries carry the revision that last wrote them. */
  readonly memoryRevision: number;
  /** The revision that last removed an entry. Removals leave no entry to carry it. */
  readonly memoryRemovedRevision: number;
}

export interface WorkstreamThreadRecord extends WorkstreamMembership {
  /** The newest run judged for memory. Earlier runs are never judged again. */
  readonly memoryRunId: string | null;
  readonly memoryRunOrdinal: number;
  /** The provider thread that last received memory, and the revision it saw. */
  readonly deliveredProviderThreadId: string | null;
  readonly deliveredRevision: number;
}

export interface WorkstreamStoredConfig {
  readonly gateEnabled: boolean;
  readonly gateThreshold: number;
  readonly mergeModelSelection: ModelSelection | null;
}

export type WorkstreamMemoryOperation =
  | {
      readonly op: "add";
      readonly id: WorkstreamMemoryEntryId;
      readonly kind: WorkstreamMemoryEntryKind;
      readonly text: string;
      readonly sourceThreadId: ThreadId | null;
      readonly locked: boolean;
    }
  | {
      readonly op: "update";
      readonly id: WorkstreamMemoryEntryId;
      readonly kind?: WorkstreamMemoryEntryKind | undefined;
      readonly text?: string | undefined;
      readonly locked?: boolean | undefined;
      readonly sourceThreadId?: ThreadId | null | undefined;
      /** Set by automatic updates: apply only to an unlocked entry still at this revision. */
      readonly ifRevision?: number | undefined;
    }
  | {
      readonly op: "delete";
      readonly id: WorkstreamMemoryEntryId;
      readonly ifRevision?: number | undefined;
    };

const isWorkstreamIcon = Schema.is(WorkstreamIcon);
const isWorkstreamColor = Schema.is(WorkstreamColor);

const toWorkstream = (row: WorkstreamReadRow): WorkstreamRecord => ({
  id: row.workstream_id,
  name: row.name as Workstream["name"],
  // Rows from before icons existed, or holding one since removed, fall back to the id's own.
  icon: isWorkstreamIcon(row.icon) ? row.icon : defaultWorkstreamAppearance(row.workstream_id).icon,
  color: isWorkstreamColor(row.color)
    ? row.color
    : defaultWorkstreamAppearance(row.workstream_id).color,
  orderKey: row.order_key,
  defaultProjectId: row.default_project_id,
  memory: {
    enabled: row.memory_enabled === 1,
    instructions: row.memory_instructions,
    budgetChars: row.memory_budget_chars,
  },
  memoryRevision: row.memory_revision,
  memoryRemovedRevision: row.removed_revision ?? 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toThread = (row: ThreadRow): WorkstreamThreadRecord => ({
  threadId: row.thread_id,
  workstreamId: row.workstream_id,
  pinnedAt: row.pinned_at,
  pinOrderKey: row.pin_order_key,
  memoryRunId: row.memory_run_id,
  memoryRunOrdinal: row.memory_run_ordinal,
  deliveredProviderThreadId: row.delivered_provider_thread_id,
  deliveredRevision: row.delivered_revision,
});

const toEntry = (row: EntryRow): WorkstreamMemoryEntry => ({
  id: row.entry_id,
  workstreamId: row.workstream_id,
  kind: row.kind,
  text: row.text,
  sourceThreadId: row.source_thread_id,
  locked: row.locked === 1,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const decodeModelSelection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));
const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));

type Sql<A> = Effect.Effect<A, SqlError.SqlError>;

export class WorkstreamRepository extends Context.Service<
  WorkstreamRepository,
  {
    readonly listWorkstreams: Sql<ReadonlyArray<WorkstreamRecord>>;
    readonly getWorkstream: (id: WorkstreamId) => Sql<Option.Option<WorkstreamRecord>>;
    readonly insertWorkstream: (workstream: Workstream) => Sql<void>;
    readonly updateWorkstream: (workstream: Workstream) => Sql<void>;
    /** Deletes the workstream with its memberships and memory. */
    readonly deleteWorkstream: (id: WorkstreamId) => Sql<void>;
    /**
     * Memberships of threads a client can list. A draft's row waits until its first message, and
     * an archived thread keeps its row for when it is restored.
     */
    readonly listThreads: Sql<ReadonlyArray<WorkstreamThreadRecord>>;
    readonly getThread: (threadId: ThreadId) => Sql<Option.Option<WorkstreamThreadRecord>>;
    /** Null removes the thread from its workstream. A move resets its pin and delivery marks. */
    readonly assignThread: (input: {
      readonly threadId: ThreadId;
      readonly workstreamId: WorkstreamId | null;
      readonly now: string;
    }) => Sql<void>;
    readonly setThreadPin: (input: {
      readonly threadId: ThreadId;
      readonly pinnedAt: string | null;
      readonly pinOrderKey: string | null;
    }) => Sql<void>;
    readonly setThreadMemoryRun: (input: {
      readonly threadId: ThreadId;
      readonly runId: string;
      readonly ordinal: number;
    }) => Sql<void>;
    /** Does nothing if the thread has left `workstreamId` since the memory was read. */
    readonly setThreadDelivery: (input: {
      readonly threadId: ThreadId;
      readonly workstreamId: WorkstreamId;
      readonly providerThreadId: string;
      readonly revision: number;
    }) => Sql<void>;
    readonly listEntries: (id: WorkstreamId) => Sql<ReadonlyArray<WorkstreamMemoryEntry>>;
    readonly getEntry: (id: WorkstreamMemoryEntryId) => Sql<Option.Option<WorkstreamMemoryEntry>>;
    /** Applies the operations under one new revision and returns it, or 0 if the workstream is gone. */
    readonly applyMemoryOperations: (input: {
      readonly workstreamId: WorkstreamId;
      readonly operations: ReadonlyArray<WorkstreamMemoryOperation>;
      readonly now: string;
    }) => Sql<number>;
    readonly clearEntries: (id: WorkstreamId, now: string) => Sql<void>;
    readonly getConfig: Sql<WorkstreamStoredConfig>;
    readonly setConfig: (config: WorkstreamStoredConfig) => Sql<void>;
  }
>()("t3/workstreams/WorkstreamRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-owned tables are created here instead of in a numbered migration: upstream keeps adding
  // migration ids, and a recorded id is skipped rather than reconciled by name after a merge.
  yield* sql`
    CREATE TABLE IF NOT EXISTS workstreams (
      workstream_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      order_key TEXT NOT NULL,
      default_project_id TEXT,
      icon TEXT,
      color TEXT,
      memory_enabled INTEGER NOT NULL,
      memory_instructions TEXT NOT NULL,
      memory_budget_chars INTEGER NOT NULL,
      memory_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workstream_threads (
      thread_id TEXT PRIMARY KEY,
      workstream_id TEXT NOT NULL,
      pinned_at TEXT,
      pin_order_key TEXT,
      added_at TEXT NOT NULL,
      memory_run_id TEXT,
      memory_run_ordinal INTEGER NOT NULL DEFAULT 0,
      delivered_provider_thread_id TEXT,
      delivered_revision INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID
  `;
  // Columns added after the first build: CREATE TABLE IF NOT EXISTS leaves an older table as it was.
  const workstreamColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('workstreams')
  `;
  if (!workstreamColumns.some((column) => column.name === "icon")) {
    yield* sql`ALTER TABLE workstreams ADD COLUMN icon TEXT`;
    yield* sql`ALTER TABLE workstreams ADD COLUMN color TEXT`;
  }
  const threadColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('workstream_threads')
  `;
  if (!threadColumns.some((column) => column.name === "memory_run_ordinal")) {
    yield* sql`
      ALTER TABLE workstream_threads ADD COLUMN memory_run_ordinal INTEGER NOT NULL DEFAULT 0
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS workstream_threads_by_workstream
    ON workstream_threads (workstream_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workstream_memory_entries (
      entry_id TEXT PRIMARY KEY,
      workstream_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      source_thread_id TEXT,
      locked INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS workstream_memory_entries_by_workstream
    ON workstream_memory_entries (workstream_id, created_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workstream_memory_removals (
      workstream_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workstream_config (
      config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
      gate_enabled INTEGER NOT NULL,
      gate_threshold REAL NOT NULL,
      merge_model_selection_json TEXT
    )
  `;

  const getWorkstream = Effect.fn("WorkstreamRepository.getWorkstream")(function* (
    id: WorkstreamId,
  ) {
    const rows = yield* sql<WorkstreamReadRow>`
      SELECT workstreams.*, removals.revision AS removed_revision
      FROM workstreams
      LEFT JOIN workstream_memory_removals AS removals USING (workstream_id)
      WHERE workstream_id = ${id}
    `;
    return Option.fromNullishOr(rows[0]).pipe(Option.map(toWorkstream));
  });

  const bumpRevision = Effect.fn("WorkstreamRepository.bumpRevision")(function* (
    workstreamId: WorkstreamId,
    now: string,
  ) {
    const rows = yield* sql<{ readonly memory_revision: number }>`
      UPDATE workstreams
      SET memory_revision = memory_revision + 1, updated_at = ${now}
      WHERE workstream_id = ${workstreamId}
      RETURNING memory_revision
    `;
    return rows[0]?.memory_revision ?? 0;
  });

  const recordRemoval = (workstreamId: WorkstreamId, revision: number) =>
    sql`
      INSERT INTO workstream_memory_removals (workstream_id, revision)
      VALUES (${workstreamId}, ${revision})
      ON CONFLICT (workstream_id) DO UPDATE SET revision = excluded.revision
    `;

  return WorkstreamRepository.of({
    listWorkstreams: sql<WorkstreamReadRow>`
      SELECT workstreams.*, removals.revision AS removed_revision
      FROM workstreams
      LEFT JOIN workstream_memory_removals AS removals USING (workstream_id)
      ORDER BY order_key
    `.pipe(Effect.map((rows) => rows.map(toWorkstream))),
    getWorkstream,
    insertWorkstream: Effect.fn("WorkstreamRepository.insertWorkstream")(function* (workstream) {
      yield* sql`
        INSERT INTO workstreams (
          workstream_id, name, order_key, default_project_id, icon, color, memory_enabled,
          memory_instructions, memory_budget_chars, created_at, updated_at
        ) VALUES (
          ${workstream.id}, ${workstream.name}, ${workstream.orderKey},
          ${workstream.defaultProjectId}, ${workstream.icon}, ${workstream.color},
          ${workstream.memory.enabled ? 1 : 0},
          ${workstream.memory.instructions}, ${workstream.memory.budgetChars},
          ${workstream.createdAt}, ${workstream.updatedAt}
        )
      `;
    }),
    updateWorkstream: Effect.fn("WorkstreamRepository.updateWorkstream")(function* (workstream) {
      yield* sql`
        UPDATE workstreams SET
          name = ${workstream.name},
          order_key = ${workstream.orderKey},
          default_project_id = ${workstream.defaultProjectId},
          icon = ${workstream.icon},
          color = ${workstream.color},
          memory_enabled = ${workstream.memory.enabled ? 1 : 0},
          memory_instructions = ${workstream.memory.instructions},
          memory_budget_chars = ${workstream.memory.budgetChars},
          updated_at = ${workstream.updatedAt}
        WHERE workstream_id = ${workstream.id}
      `;
    }),
    deleteWorkstream: Effect.fn("WorkstreamRepository.deleteWorkstream")(function* (id) {
      yield* sql`DELETE FROM workstream_memory_entries WHERE workstream_id = ${id}`;
      yield* sql`DELETE FROM workstream_memory_removals WHERE workstream_id = ${id}`;
      yield* sql`DELETE FROM workstream_threads WHERE workstream_id = ${id}`;
      yield* sql`DELETE FROM workstreams WHERE workstream_id = ${id}`;
    }, sql.withTransaction),
    listThreads: sql<ThreadRow>`
      SELECT memberships.*
      FROM workstream_threads AS memberships
      JOIN orchestration_v2_projection_threads AS threads USING (thread_id)
      WHERE threads.deleted_at IS NULL AND threads.archived_at IS NULL
    `.pipe(Effect.map((rows) => rows.map(toThread))),
    getThread: Effect.fn("WorkstreamRepository.getThread")(function* (threadId) {
      const rows = yield* sql<ThreadRow>`
        SELECT * FROM workstream_threads WHERE thread_id = ${threadId}
      `;
      return Option.fromNullishOr(rows[0]).pipe(Option.map(toThread));
    }),
    assignThread: Effect.fn("WorkstreamRepository.assignThread")(function* ({
      threadId,
      workstreamId,
      now,
    }) {
      if (workstreamId === null) {
        yield* sql`DELETE FROM workstream_threads WHERE thread_id = ${threadId}`;
        return;
      }
      yield* sql`
        INSERT INTO workstream_threads (thread_id, workstream_id, added_at)
        VALUES (${threadId}, ${workstreamId}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET
          workstream_id = excluded.workstream_id,
          added_at = excluded.added_at,
          pinned_at = NULL,
          pin_order_key = NULL,
          delivered_provider_thread_id = NULL,
          delivered_revision = 0
        WHERE workstream_threads.workstream_id <> excluded.workstream_id
      `;
    }),
    setThreadPin: Effect.fn("WorkstreamRepository.setThreadPin")(function* (input) {
      yield* sql`
        UPDATE workstream_threads
        SET pinned_at = ${input.pinnedAt}, pin_order_key = ${input.pinOrderKey}
        WHERE thread_id = ${input.threadId}
      `;
    }),
    setThreadMemoryRun: Effect.fn("WorkstreamRepository.setThreadMemoryRun")(function* (input) {
      yield* sql`
        UPDATE workstream_threads
        SET memory_run_id = ${input.runId}, memory_run_ordinal = ${input.ordinal}
        WHERE thread_id = ${input.threadId}
      `;
    }),
    setThreadDelivery: Effect.fn("WorkstreamRepository.setThreadDelivery")(function* (input) {
      yield* sql`
        UPDATE workstream_threads
        SET delivered_provider_thread_id = ${input.providerThreadId},
            delivered_revision = ${input.revision}
        WHERE thread_id = ${input.threadId} AND workstream_id = ${input.workstreamId}
      `;
    }),
    listEntries: Effect.fn("WorkstreamRepository.listEntries")(function* (id) {
      const rows = yield* sql<EntryRow>`
        SELECT * FROM workstream_memory_entries
        WHERE workstream_id = ${id}
        ORDER BY created_at, entry_id
      `;
      return rows.map(toEntry);
    }),
    getEntry: Effect.fn("WorkstreamRepository.getEntry")(function* (id) {
      const rows = yield* sql<EntryRow>`
        SELECT * FROM workstream_memory_entries WHERE entry_id = ${id}
      `;
      return Option.fromNullishOr(rows[0]).pipe(Option.map(toEntry));
    }),
    applyMemoryOperations: Effect.fn("WorkstreamRepository.applyMemoryOperations")(function* ({
      workstreamId,
      operations,
      now,
    }) {
      const revision = yield* bumpRevision(workstreamId, now);
      // Deleted while a merge was waiting on the model: nothing may be written under its id.
      if (revision === 0) return 0;
      // The model answered against an older read; a user's edit or lock since then wins.
      const unchanged = (ifRevision: number | undefined) =>
        ifRevision === undefined ? sql`1 = 1` : sql`locked = 0 AND revision = ${ifRevision}`;
      for (const operation of operations) {
        switch (operation.op) {
          case "add":
            yield* sql`
              INSERT INTO workstream_memory_entries (
                entry_id, workstream_id, kind, text, source_thread_id, locked, revision,
                created_at, updated_at
              ) VALUES (
                ${operation.id}, ${workstreamId}, ${operation.kind}, ${operation.text},
                ${operation.sourceThreadId}, ${operation.locked ? 1 : 0}, ${revision},
                ${now}, ${now}
              )
            `;
            break;
          case "update": {
            const locked = operation.locked === undefined ? null : operation.locked ? 1 : 0;
            yield* sql`
              UPDATE workstream_memory_entries SET
                kind = COALESCE(${operation.kind ?? null}, kind),
                text = COALESCE(${operation.text ?? null}, text),
                locked = COALESCE(${locked}, locked),
                revision = ${revision},
                updated_at = ${now}
              WHERE entry_id = ${operation.id} AND workstream_id = ${workstreamId}
                AND ${unchanged(operation.ifRevision)}
            `;
            if (operation.sourceThreadId !== undefined) {
              yield* sql`
                UPDATE workstream_memory_entries
                SET source_thread_id = ${operation.sourceThreadId}
                WHERE entry_id = ${operation.id} AND workstream_id = ${workstreamId}
                  AND revision = ${revision}
              `;
            }
            break;
          }
          case "delete": {
            const removed = yield* sql`
              DELETE FROM workstream_memory_entries
              WHERE entry_id = ${operation.id} AND workstream_id = ${workstreamId}
                AND ${unchanged(operation.ifRevision)}
              RETURNING entry_id
            `;
            if (removed.length > 0) yield* recordRemoval(workstreamId, revision);
            break;
          }
        }
      }
      return revision;
    }, sql.withTransaction),
    clearEntries: Effect.fn("WorkstreamRepository.clearEntries")(function* (id, now) {
      yield* sql`DELETE FROM workstream_memory_entries WHERE workstream_id = ${id}`;
      yield* recordRemoval(id, yield* bumpRevision(id, now));
    }, sql.withTransaction),
    getConfig: sql<ConfigRow>`SELECT * FROM workstream_config WHERE config_id = 1`.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return {
          gateEnabled: row === undefined ? true : row.gate_enabled === 1,
          gateThreshold: row?.gate_threshold ?? WORKSTREAM_MEMORY_DEFAULT_GATE_THRESHOLD,
          mergeModelSelection:
            row?.merge_model_selection_json == null
              ? null
              : Option.getOrNull(decodeModelSelection(row.merge_model_selection_json)),
        };
      }),
    ),
    setConfig: Effect.fn("WorkstreamRepository.setConfig")(function* (config) {
      const mergeModelSelection =
        config.mergeModelSelection === null
          ? null
          : encodeModelSelection(config.mergeModelSelection);
      yield* sql`
        INSERT INTO workstream_config (
          config_id, gate_enabled, gate_threshold, merge_model_selection_json
        ) VALUES (
          1, ${config.gateEnabled ? 1 : 0}, ${config.gateThreshold}, ${mergeModelSelection}
        )
        ON CONFLICT (config_id) DO UPDATE SET
          gate_enabled = excluded.gate_enabled,
          gate_threshold = excluded.gate_threshold,
          merge_model_selection_json = excluded.merge_model_selection_json
      `;
    }),
  });
});

export const layer = Layer.effect(WorkstreamRepository, make);
