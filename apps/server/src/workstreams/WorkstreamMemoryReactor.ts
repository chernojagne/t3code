import {
  type RunId,
  type ThreadId,
  type WorkstreamId,
  WorkstreamMemoryEntryId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  isTurnWorthConsidering,
  makeGateInstructions,
  makeMergePrompt,
  makeTurnDigest,
  parseMergeReply,
  planMemoryOperations,
} from "./WorkstreamMemory.ts";
import * as WorkstreamMemoryGate from "./WorkstreamMemoryGate.ts";
import * as WorkstreamRepository from "./WorkstreamRepository.ts";
import * as WorkstreamService from "./WorkstreamService.ts";

export type ConsolidationOutcome =
  | "not-in-workstream"
  | "memory-disabled"
  | "already-done"
  | "filtered"
  | "gated"
  | "unchanged"
  | "updated";

/** Keeps workstream memory current: folds each finished turn into its workstream's entries. */
export class WorkstreamMemoryReactor extends Context.Service<
  WorkstreamMemoryReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Folds one finished run into memory. Safe to repeat for the same run. */
    readonly consolidate: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<ConsolidationOutcome>;
  }
>()("t3/workstreams/WorkstreamMemoryReactor") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const repository = yield* WorkstreamRepository.WorkstreamRepository;
  const workstreams = yield* WorkstreamService.WorkstreamService;
  const gate = yield* WorkstreamMemoryGate.WorkstreamMemoryGate;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  // Merges read the entries and then write them, so one workstream merges one turn at a time.
  const merges = yield* KeyedLock.make<WorkstreamId>();
  const reactions = yield* KeyedLock.makeRunner<ThreadId>();

  const consolidateRun = Effect.fn("WorkstreamMemoryReactor.consolidateRun")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    const membership = yield* repository.getThread(input.threadId);
    if (Option.isNone(membership)) return "not-in-workstream" as const;
    if (membership.value.memoryRunId === input.runId) return "already-done" as const;
    const found = yield* repository.getWorkstream(membership.value.workstreamId);
    if (Option.isNone(found)) return "not-in-workstream" as const;
    const workstream = found.value;
    if (!workstream.memory.enabled) return "memory-disabled" as const;

    const records = yield* threads.getThreadRecords(input.threadId, ["turnItems", "runs"], {
      turnItemRunIds: [input.runId],
      runIds: [input.runId],
    });
    const run = records.runs.find((candidate) => candidate.id === input.runId);
    const digest = makeTurnDigest(records.turnItems);
    // Marked before the model calls: a turn is judged once, even if a later step fails.
    yield* repository.setThreadMemoryRun(input.threadId, input.runId);
    if (run === undefined || !isTurnWorthConsidering({ runStatus: run.status, digest })) {
      return "filtered" as const;
    }

    const settings = yield* workstreams.gateSettings;
    if (settings.enabled && Option.isSome(settings.apiKey)) {
      // A gate that cannot answer lets the turn through: losing memory is worse than one merge.
      const probability = yield* gate
        .probability({
          apiKey: settings.apiKey.value,
          digest: digest.text,
          instructions: makeGateInstructions(workstream.memory.instructions),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Workstream memory gate failed; merging without it", {
              detail: error.detail,
            }).pipe(Effect.as(1)),
          ),
        );
      if (probability < settings.threshold) return "gated" as const;
    }

    return yield* merges.withLock(
      workstream.id,
      Effect.gen(function* () {
        const entries = yield* workstreams.listEntries(workstream.id);
        const modelSelection =
          settings.mergeModelSelection ??
          (yield* serverSettings.getSettings).textGenerationModelSelection;
        // Providers run in a working directory; the merge must not read a checkout.
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workstream-memory-" });
        // The transcription operation is the one text-generation call that passes a prompt
        // through unchanged on every provider, so the merge borrows it.
        const reply = yield* textGeneration.generateTranscriptionPostProcessing({
          cwd,
          prompt: makeMergePrompt({
            workstreamName: workstream.name,
            instructions: workstream.memory.instructions,
            budgetChars: workstream.memory.budgetChars,
            entries,
            digest: digest.text,
          }),
          modelSelection,
        });
        const ids: Array<WorkstreamMemoryEntryId> = [];
        const proposed = parseMergeReply(reply.transcription);
        for (const operation of proposed) {
          if (operation.op !== "add") continue;
          const bytes = yield* random.randomBytes(12);
          ids.push(WorkstreamMemoryEntryId.make(`memory:${Buffer.from(bytes).toString("hex")}`));
        }
        const operations = planMemoryOperations({
          entries,
          proposed,
          threadId: input.threadId,
          ids,
        });
        if (operations.length === 0) return "unchanged" as const;
        yield* workstreams.applyMemoryOperations({ workstreamId: workstream.id, operations });
        return "updated" as const;
      }).pipe(Effect.scoped),
    );
  });

  const consolidate: WorkstreamMemoryReactor["Service"]["consolidate"] = (input) =>
    consolidateRun(input).pipe(
      Effect.tap((outcome) =>
        outcome === "not-in-workstream" || outcome === "already-done"
          ? Effect.void
          : Effect.log("Workstream memory considered a turn", { ...input, outcome }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Workstream memory update failed", {
              threadId: input.threadId,
              runId: input.runId,
              cause,
            }).pipe(Effect.as("unchanged" as const)),
      ),
    );

  return WorkstreamMemoryReactor.of({
    consolidate,
    start: Effect.fn("WorkstreamMemoryReactor.start")(function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) => {
          switch (event.type) {
            case "thread.created": {
              const { parentThreadId, sideChat } = event.payload.lineage;
              return parentThreadId === null || sideChat === true
                ? Effect.void
                : workstreams
                    .inheritWorkstream({ threadId: event.threadId, parentThreadId })
                    .pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("Could not inherit a workstream", { cause }),
                      ),
                    );
            }
            case "run.updated":
              return event.payload.status === "completed"
                ? reactions.run(
                    event.threadId,
                    consolidate({ threadId: event.threadId, runId: event.payload.id }).pipe(
                      Effect.asVoid,
                    ),
                  )
                : Effect.void;
            default:
              return Effect.void;
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Workstream memory event stream failed", { cause }),
          ),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(WorkstreamMemoryReactor, make);
