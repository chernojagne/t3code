import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2DomainEvent,
  RunId,
  type ThreadId,
  type WorkstreamMemoryState,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { layerCountingRandom, messageItem, OTHER_THREAD, THREAD } from "./testkit.ts";
import * as WorkstreamMemoryGate from "./WorkstreamMemoryGate.ts";
import * as WorkstreamMemoryReactor from "./WorkstreamMemoryReactor.ts";
import * as WorkstreamService from "./WorkstreamService.ts";

const RUN = RunId.make("run:two");
const EARLIER_RUN = RunId.make("run:one");
const DECISION = "We keep the v1 endpoint until every client has moved to v2, per the user.";

interface Scenario {
  /** A stored OpenAI key; absent means the gate is skipped. */
  readonly apiKey?: string;
  readonly gate?: Effect.Effect<number, WorkstreamMemoryGate.WorkstreamMemoryGateError>;
  readonly runStatus?: string;
  readonly reply?: string;
  readonly events?: Queue.Queue<OrchestrationV2DomainEvent>;
}

function setup(scenario: Scenario = {}) {
  const calls = { gate: 0, merge: 0 };
  const layer = WorkstreamMemoryReactor.layer.pipe(
    Layer.provideMerge(WorkstreamService.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () =>
            scenario.apiKey === undefined
              ? Effect.succeedNone
              : Effect.succeedSome(new TextEncoder().encode(scenario.apiKey)),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          streamDomainEvents:
            scenario.events === undefined ? Stream.never : Stream.fromQueue(scenario.events),
          getThreadRecords: () =>
            Effect.succeed({
              turnItems: [
                messageItem("user", "Which endpoint do we keep while clients migrate?"),
                messageItem("assistant", DECISION),
              ],
              runs: [
                { id: RUN, ordinal: 2, status: scenario.runStatus ?? "completed" },
                { id: EARLIER_RUN, ordinal: 1, status: "completed" },
              ],
            } as never),
        }),
        Layer.mock(WorkstreamMemoryGate.WorkstreamMemoryGate)({
          probability: () =>
            Effect.suspend(() => {
              calls.gate += 1;
              return scenario.gate ?? Effect.succeed(0.9);
            }),
        }),
        Layer.mock(TextGeneration.TextGeneration)({
          generateTranscriptionPostProcessing: () =>
            Effect.sync(() => {
              calls.merge += 1;
              return {
                transcription:
                  scenario.reply ??
                  JSON.stringify([{ op: "add", kind: "decision", text: DECISION }]),
              };
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        layerCountingRandom,
        NodeServices.layer,
      ),
    ),
    Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
  );
  return { calls, layer };
}

const joinWorkstream = Effect.fn("test.joinWorkstream")(function* (threadId: ThreadId) {
  const service = yield* WorkstreamService.WorkstreamService;
  const { workstreamId } = yield* service.mutate({
    type: "workstream.create",
    name: "Checkout rewrite" as never,
  });
  yield* service.mutate({ type: "thread.assign", threadId, workstreamId: workstreamId! });
  return workstreamId!;
});

it.effect("folds a finished turn into memory once, and it outlives the session", () => {
  const { calls, layer } = setup({ apiKey: "sk-test" });
  return Effect.gen(function* () {
    const reactor = yield* WorkstreamMemoryReactor.WorkstreamMemoryReactor;
    const service = yield* WorkstreamService.WorkstreamService;
    const workstreamId = yield* joinWorkstream(THREAD);

    assert.strictEqual(yield* reactor.consolidate({ threadId: THREAD, runId: RUN }), "updated");
    assert.strictEqual(
      yield* reactor.consolidate({ threadId: THREAD, runId: RUN }),
      "already-done",
    );
    // A late bookkeeping update to an earlier finished run must not be judged after a newer one.
    assert.strictEqual(
      yield* reactor.consolidate({ threadId: THREAD, runId: EARLIER_RUN }),
      "already-done",
    );
    assert.deepStrictEqual(calls, { gate: 1, merge: 1 });

    yield* service.mutate({ type: "thread.assign", threadId: THREAD, workstreamId: null });
    const entries = yield* service.listEntries(workstreamId);
    assert.deepStrictEqual(
      entries.map((entry) => [entry.kind, entry.text, entry.sourceThreadId]),
      [["decision", DECISION, THREAD]],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a turn below the gate threshold never reaches the merge model", () => {
  const { calls, layer } = setup({ apiKey: "sk-test", gate: Effect.succeed(0.1) });
  return Effect.gen(function* () {
    const reactor = yield* WorkstreamMemoryReactor.WorkstreamMemoryReactor;
    yield* joinWorkstream(THREAD);
    assert.strictEqual(yield* reactor.consolidate({ threadId: THREAD, runId: RUN }), "gated");
    assert.deepStrictEqual(calls, { gate: 1, merge: 0 });
  }).pipe(Effect.provide(layer));
});

it.effect("without a key the gate is skipped, and a failing gate lets the turn through", () => {
  const keyless = setup();
  const failing = setup({
    apiKey: "sk-test",
    gate: Effect.fail(new WorkstreamMemoryGate.WorkstreamMemoryGateError({ detail: "down" })),
  });
  const run = (scenario: ReturnType<typeof setup>) =>
    Effect.gen(function* () {
      const reactor = yield* WorkstreamMemoryReactor.WorkstreamMemoryReactor;
      yield* joinWorkstream(THREAD);
      return yield* reactor.consolidate({ threadId: THREAD, runId: RUN });
    }).pipe(Effect.provide(scenario.layer));
  return Effect.gen(function* () {
    assert.strictEqual(yield* run(keyless), "updated");
    assert.deepStrictEqual(keyless.calls, { gate: 0, merge: 1 });
    assert.strictEqual(yield* run(failing), "updated");
    assert.deepStrictEqual(failing.calls, { gate: 1, merge: 1 });
  });
});

it.effect(
  "skips sessions outside a workstream, unfinished runs and disabled memory for free",
  () => {
    const outside = setup({ apiKey: "sk-test" });
    const interrupted = setup({ apiKey: "sk-test", runStatus: "interrupted" });
    const disabled = setup({ apiKey: "sk-test" });
    return Effect.gen(function* () {
      assert.strictEqual(
        yield* Effect.gen(function* () {
          const reactor = yield* WorkstreamMemoryReactor.WorkstreamMemoryReactor;
          return yield* reactor.consolidate({ threadId: OTHER_THREAD, runId: RUN });
        }).pipe(Effect.provide(outside.layer)),
        "not-in-workstream",
      );
      assert.strictEqual(
        yield* Effect.gen(function* () {
          const reactor = yield* WorkstreamMemoryReactor.WorkstreamMemoryReactor;
          yield* joinWorkstream(THREAD);
          return yield* reactor.consolidate({ threadId: THREAD, runId: RUN });
        }).pipe(Effect.provide(interrupted.layer)),
        "filtered",
      );
      assert.strictEqual(
        yield* Effect.gen(function* () {
          const reactor = yield* WorkstreamMemoryReactor.WorkstreamMemoryReactor;
          const service = yield* WorkstreamService.WorkstreamService;
          const workstreamId = yield* joinWorkstream(THREAD);
          yield* service.mutate({ type: "workstream.update", workstreamId, memoryEnabled: false });
          return yield* reactor.consolidate({ threadId: THREAD, runId: RUN });
        }).pipe(Effect.provide(disabled.layer)),
        "memory-disabled",
      );
      for (const scenario of [outside, interrupted, disabled]) {
        assert.deepStrictEqual(scenario.calls, { gate: 0, merge: 0 });
      }
    });
  },
);

it.effect("reacts to run and thread events from the orchestrator", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    yield* reactsToEvents(events).pipe(Effect.provide(setup({ events }).layer));
  }),
);

const reactsToEvents = (events: Queue.Queue<OrchestrationV2DomainEvent>) =>
  Effect.gen(function* () {
    const reactor = yield* WorkstreamMemoryReactor.WorkstreamMemoryReactor;
    const service = yield* WorkstreamService.WorkstreamService;
    const workstreamId = yield* joinWorkstream(THREAD);
    const remembered = yield* Deferred.make<WorkstreamMemoryState>();
    const subscribed = yield* Deferred.make<void>();
    yield* service.subscribeMemory(workstreamId).pipe(
      Stream.runForEach((state) =>
        state.entries.length > 0
          ? Deferred.succeed(remembered, state)
          : Deferred.succeed(subscribed, undefined),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    yield* reactor.start();

    yield* Queue.offer(events, {
      type: "thread.created",
      threadId: OTHER_THREAD,
      payload: { lineage: { parentThreadId: THREAD, relationshipToParent: "subagent" } },
    } as never);
    yield* Queue.offer(events, {
      type: "run.updated",
      threadId: THREAD,
      payload: { id: RUN, status: "completed" },
    } as never);

    const state = yield* Deferred.await(remembered);
    assert.strictEqual(state.entries[0]?.text, DECISION);
    // Events are handled in order, so the child was placed before the run was folded in.
    const child = yield* service.workstreamOfThread(OTHER_THREAD);
    assert.strictEqual(Option.getOrThrow(child).id, workstreamId);
  });
