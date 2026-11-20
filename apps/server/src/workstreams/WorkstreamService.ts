import {
  type ThreadId,
  type Workstream,
  WorkstreamError,
  WorkstreamId,
  type WorkstreamMemoryEntry,
  WorkstreamMemoryEntryId,
  type WorkstreamMemoryEntryKind,
  type WorkstreamMemoryMutation,
  type WorkstreamMemoryState,
  type WorkstreamMutation,
  type WorkstreamMutationResult,
  type WorkstreamState,
  WORKSTREAM_MEMORY_DEFAULT_BUDGET_CHARS,
} from "@t3tools/contracts";
import { pinOrderKeyBetween } from "@t3tools/shared/pinOrderKey";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkstreamRepository from "./WorkstreamRepository.ts";

const GATE_API_KEY_SECRET = "workstream-memory-openai-api-key";

export class WorkstreamService extends Context.Service<
  WorkstreamService,
  {
    readonly subscribe: () => Stream.Stream<WorkstreamState, WorkstreamError>;
    readonly mutate: (
      mutation: WorkstreamMutation,
    ) => Effect.Effect<WorkstreamMutationResult, WorkstreamError>;
    readonly subscribeMemory: (
      workstreamId: WorkstreamId,
    ) => Stream.Stream<WorkstreamMemoryState, WorkstreamError>;
    readonly mutateMemory: (
      mutation: WorkstreamMemoryMutation,
    ) => Effect.Effect<void, WorkstreamError>;
    /** The workstream a session belongs to, if any. */
    readonly workstreamOfThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<WorkstreamRepository.WorkstreamRecord>, WorkstreamError>;
    /** Puts a session an agent started into its parent's workstream, unless it already has one. */
    readonly inheritWorkstream: (input: {
      readonly threadId: ThreadId;
      readonly parentThreadId: ThreadId;
    }) => Effect.Effect<void, WorkstreamError>;
    readonly listEntries: (
      workstreamId: WorkstreamId,
    ) => Effect.Effect<ReadonlyArray<WorkstreamMemoryEntry>, WorkstreamError>;
    /** Applies memory operations and tells subscribers. Returns the new revision. */
    readonly applyMemoryOperations: (input: {
      readonly workstreamId: WorkstreamId;
      readonly operations: ReadonlyArray<WorkstreamRepository.WorkstreamMemoryOperation>;
    }) => Effect.Effect<number, WorkstreamError>;
    /** Saves one entry on behalf of a session. */
    readonly remember: (input: {
      readonly workstreamId: WorkstreamId;
      readonly threadId: ThreadId;
      readonly kind: WorkstreamMemoryEntryKind;
      readonly text: string;
    }) => Effect.Effect<WorkstreamMemoryEntry, WorkstreamError>;
    readonly gateSettings: Effect.Effect<
      {
        readonly enabled: boolean;
        readonly threshold: number;
        readonly apiKey: Option.Option<string>;
        readonly mergeModelSelection: WorkstreamRepository.WorkstreamStoredConfig["mergeModelSelection"];
      },
      WorkstreamError
    >;
  }
>()("t3/workstreams/WorkstreamService") {}

const failed = (message: string) => (cause: unknown) => new WorkstreamError({ message, cause });

const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(DateTime.toUtc(now))));

const make = Effect.gen(function* () {
  const repository = yield* WorkstreamRepository.WorkstreamRepository;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const newId = (prefix: string) =>
    random.randomBytes(12).pipe(
      Effect.map((bytes) => `${prefix}:${Buffer.from(bytes).toString("hex")}`),
      Effect.mapError(failed("Could not allocate an id.")),
    );
  // Each signal re-sends the full state, so a slow subscriber needs only the newest one.
  const stateChanges = yield* PubSub.sliding<void>(1);
  const memoryChanges = yield* PubSub.sliding<void>(1);
  const stateChanged = PubSub.publish(stateChanges, undefined).pipe(Effect.asVoid);
  const memoryChanged = PubSub.publish(memoryChanges, undefined).pipe(Effect.asVoid);

  const readApiKey = secrets
    .get(GATE_API_KEY_SECRET)
    .pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.mapError(failed("Could not read the memory gate key.")),
    );

  const state: Effect.Effect<WorkstreamState, WorkstreamError> = Effect.gen(function* () {
    const workstreams = yield* repository.listWorkstreams;
    const threads = yield* repository.listThreads;
    const config = yield* repository.getConfig;
    const apiKey = yield* readApiKey;
    return {
      workstreams: workstreams.map(({ memoryRevision: _revision, ...workstream }) => workstream),
      memberships: threads.map((thread) => ({
        threadId: thread.threadId,
        workstreamId: thread.workstreamId,
        pinnedAt: thread.pinnedAt,
        pinOrderKey: thread.pinOrderKey,
      })),
      memoryConfig: {
        gateEnabled: config.gateEnabled,
        gateThreshold: config.gateThreshold,
        gateKeyConfigured: Option.isSome(apiKey),
        mergeModelSelection: config.mergeModelSelection,
      },
    };
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "WorkstreamError" ? cause : failed("Could not list workstreams.")(cause),
    ),
  );

  const requireWorkstream = Effect.fn("WorkstreamService.requireWorkstream")(function* (
    id: WorkstreamId,
  ) {
    const found = yield* repository
      .getWorkstream(id)
      .pipe(Effect.mapError(failed("Could not read the workstream.")));
    if (Option.isNone(found)) {
      return yield* new WorkstreamError({ message: "That workstream no longer exists." });
    }
    return found.value;
  });

  const requireEntry = Effect.fn("WorkstreamService.requireEntry")(function* (
    id: WorkstreamMemoryEntryId,
  ) {
    const found = yield* repository
      .getEntry(id)
      .pipe(Effect.mapError(failed("Could not read the memory entry.")));
    if (Option.isNone(found)) {
      return yield* new WorkstreamError({ message: "That memory entry no longer exists." });
    }
    return found.value;
  });

  const applyMemoryOperations: WorkstreamService["Service"]["applyMemoryOperations"] = Effect.fn(
    "WorkstreamService.applyMemoryOperations",
  )(function* ({ workstreamId, operations }) {
    const now = yield* nowIso;
    const revision = yield* repository
      .applyMemoryOperations({ workstreamId, operations, now })
      .pipe(Effect.mapError(failed("Could not save workstream memory.")));
    yield* memoryChanged;
    return revision;
  });

  const mutate: WorkstreamService["Service"]["mutate"] = Effect.fn("WorkstreamService.mutate")(
    function* (mutation) {
      const now = yield* nowIso;
      const result: WorkstreamMutationResult = yield* Effect.gen(function* () {
        switch (mutation.type) {
          case "workstream.create": {
            const existing = yield* repository.listWorkstreams;
            const lastKey = existing.at(-1)?.orderKey ?? null;
            const workstream: Workstream = {
              id: WorkstreamId.make(yield* newId("workstream")),
              name: mutation.name,
              // A corrupt last key yields null; the id keeps the fallback unique and stable.
              orderKey: pinOrderKeyBetween(lastKey, null) ?? `${lastKey ?? ""}V`,
              defaultProjectId: mutation.defaultProjectId ?? null,
              memory: {
                enabled: true,
                instructions: "",
                budgetChars: WORKSTREAM_MEMORY_DEFAULT_BUDGET_CHARS,
              },
              createdAt: now,
              updatedAt: now,
            };
            yield* repository.insertWorkstream(workstream);
            return { workstreamId: workstream.id };
          }
          case "workstream.update": {
            const { memoryRevision: _revision, ...current } = yield* requireWorkstream(
              mutation.workstreamId,
            );
            yield* repository.updateWorkstream({
              ...current,
              name: mutation.name ?? current.name,
              defaultProjectId:
                mutation.defaultProjectId === undefined
                  ? current.defaultProjectId
                  : mutation.defaultProjectId,
              orderKey: mutation.orderKey ?? current.orderKey,
              memory: {
                enabled: mutation.memoryEnabled ?? current.memory.enabled,
                instructions: mutation.memoryInstructions ?? current.memory.instructions,
                budgetChars: mutation.memoryBudgetChars ?? current.memory.budgetChars,
              },
              updatedAt: now,
            });
            return {};
          }
          case "workstream.delete":
            yield* repository.deleteWorkstream(mutation.workstreamId);
            yield* memoryChanged;
            return {};
          case "thread.assign":
            if (mutation.workstreamId !== null) yield* requireWorkstream(mutation.workstreamId);
            yield* repository.assignThread({
              threadId: mutation.threadId,
              workstreamId: mutation.workstreamId,
              now,
            });
            return {};
          case "thread.pin":
            yield* repository.setThreadPin({
              threadId: mutation.threadId,
              pinnedAt: mutation.pinned ? now : null,
              pinOrderKey: mutation.pinned ? (mutation.orderKey ?? null) : null,
            });
            return {};
          case "memory-config.update": {
            const current = yield* repository.getConfig;
            yield* repository.setConfig({
              gateEnabled: mutation.gateEnabled ?? current.gateEnabled,
              gateThreshold: mutation.gateThreshold ?? current.gateThreshold,
              mergeModelSelection:
                mutation.mergeModelSelection === undefined
                  ? current.mergeModelSelection
                  : mutation.mergeModelSelection,
            });
            if (mutation.gateApiKey === null) {
              yield* secrets.remove(GATE_API_KEY_SECRET);
            } else if (mutation.gateApiKey !== undefined) {
              yield* secrets.set(
                GATE_API_KEY_SECRET,
                new TextEncoder().encode(mutation.gateApiKey),
              );
            }
            return {};
          }
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause._tag === "WorkstreamError"
            ? cause
            : failed("Could not save the workstream change.")(cause),
        ),
      );
      yield* stateChanged;
      return result;
    },
  );

  const mutateMemory: WorkstreamService["Service"]["mutateMemory"] = Effect.fn(
    "WorkstreamService.mutateMemory",
  )(function* (mutation) {
    switch (mutation.type) {
      case "entry.add":
        yield* requireWorkstream(mutation.workstreamId);
        yield* applyMemoryOperations({
          workstreamId: mutation.workstreamId,
          operations: [
            {
              op: "add",
              id: WorkstreamMemoryEntryId.make(yield* newId("memory")),
              kind: mutation.kind,
              text: mutation.text,
              sourceThreadId: null,
              locked: mutation.locked ?? false,
            },
          ],
        });
        return;
      case "entry.update": {
        const entry = yield* requireEntry(mutation.entryId);
        yield* applyMemoryOperations({
          workstreamId: entry.workstreamId,
          operations: [
            {
              op: "update",
              id: entry.id,
              kind: mutation.kind,
              text: mutation.text,
              locked: mutation.locked,
              // The user now owns the wording, so every session is told, its first author included.
              ...(mutation.kind === undefined && mutation.text === undefined
                ? {}
                : { sourceThreadId: null }),
            },
          ],
        });
        return;
      }
      case "entry.delete": {
        const entry = yield* requireEntry(mutation.entryId);
        yield* applyMemoryOperations({
          workstreamId: entry.workstreamId,
          operations: [{ op: "delete", id: entry.id }],
        });
        return;
      }
      case "memory.clear": {
        const now = yield* nowIso;
        yield* repository
          .clearEntries(mutation.workstreamId, now)
          .pipe(Effect.mapError(failed("Could not clear workstream memory.")));
        yield* memoryChanged;
        return;
      }
    }
  });

  const listEntries: WorkstreamService["Service"]["listEntries"] = (workstreamId) =>
    repository
      .listEntries(workstreamId)
      .pipe(Effect.mapError(failed("Could not read workstream memory.")));

  const workstreamOfThread: WorkstreamService["Service"]["workstreamOfThread"] = Effect.fn(
    "WorkstreamService.workstreamOfThread",
  )(
    function* (threadId) {
      const membership = yield* repository.getThread(threadId);
      if (Option.isNone(membership)) return Option.none();
      return yield* repository.getWorkstream(membership.value.workstreamId);
    },
    Effect.mapError(failed("Could not read the session's workstream.")),
  );

  return WorkstreamService.of({
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading to buffer concurrent changes.
          const subscription = yield* PubSub.subscribe(stateChanges);
          return Stream.concat(
            Stream.fromEffect(state),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => state)),
          );
        }),
      ),
    mutate,
    subscribeMemory: (workstreamId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(memoryChanges);
          const read = listEntries(workstreamId).pipe(Effect.map((entries) => ({ entries })));
          return Stream.concat(
            Stream.fromEffect(read),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read)),
          );
        }),
      ),
    mutateMemory,
    workstreamOfThread,
    inheritWorkstream: Effect.fn("WorkstreamService.inheritWorkstream")(
      function* ({ threadId, parentThreadId }) {
        const parent = yield* repository.getThread(parentThreadId);
        if (Option.isNone(parent)) return;
        if (Option.isSome(yield* repository.getThread(threadId))) return;
        yield* repository.assignThread({
          threadId,
          workstreamId: parent.value.workstreamId,
          now: yield* nowIso,
        });
        yield* stateChanged;
      },
      Effect.mapError(failed("Could not place the session in its parent's workstream.")),
    ),
    listEntries,
    applyMemoryOperations,
    remember: Effect.fn("WorkstreamService.remember")(function* (input) {
      const id = WorkstreamMemoryEntryId.make(yield* newId("memory"));
      yield* applyMemoryOperations({
        workstreamId: input.workstreamId,
        operations: [
          {
            op: "add",
            id,
            kind: input.kind,
            text: input.text,
            sourceThreadId: input.threadId,
            locked: false,
          },
        ],
      });
      return yield* requireEntry(id);
    }),
    gateSettings: Effect.gen(function* () {
      const config = yield* repository.getConfig.pipe(
        Effect.mapError(failed("Could not read memory settings.")),
      );
      return {
        enabled: config.gateEnabled,
        threshold: config.gateThreshold,
        apiKey: yield* readApiKey,
        mergeModelSelection: config.mergeModelSelection,
      };
    }),
  });
});

export const layer = Layer.effect(WorkstreamService, make).pipe(
  Layer.provideMerge(WorkstreamRepository.layer),
);
