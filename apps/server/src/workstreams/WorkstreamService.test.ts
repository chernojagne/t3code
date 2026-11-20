import { assert, it } from "@effect/vitest";
import { ProjectId, type WorkstreamId, type WorkstreamState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { layerCountingRandom, OTHER_THREAD, THREAD } from "./testkit.ts";
import * as WorkstreamService from "./WorkstreamService.ts";

const layerSecrets = Layer.effect(
  ServerSecretStore.ServerSecretStore,
  Effect.gen(function* () {
    const stored = yield* Ref.make(new Map<string, Uint8Array>());
    return ServerSecretStore.ServerSecretStore.of({
      get: (name) => Ref.get(stored).pipe(Effect.map((map) => Option.fromNullishOr(map.get(name)))),
      set: (name, value) => Ref.update(stored, (map) => new Map(map).set(name, value)),
      create: (name, value) => Ref.update(stored, (map) => new Map(map).set(name, value)),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: (name) =>
        Ref.update(stored, (map) => {
          const next = new Map(map);
          next.delete(name);
          return next;
        }),
    });
  }),
);

const layerTest = WorkstreamService.layer.pipe(
  Layer.provide(layerSecrets),
  Layer.provide(layerCountingRandom),
  Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
);

const current = Effect.gen(function* () {
  const service = yield* WorkstreamService.WorkstreamService;
  return Option.getOrThrow(yield* service.subscribe().pipe(Stream.runHead));
});

const create = Effect.fn("test.create")(function* (name: string) {
  const service = yield* WorkstreamService.WorkstreamService;
  const result = yield* service.mutate({ type: "workstream.create", name: name as never });
  return result.workstreamId as WorkstreamId;
});

it.effect("keeps workstreams in creation order and stores a default project", () =>
  Effect.gen(function* () {
    const service = yield* WorkstreamService.WorkstreamService;
    const first = yield* create("Checkout rewrite");
    const second = yield* create("Flaky deploys");
    yield* service.mutate({
      type: "workstream.update",
      workstreamId: second,
      defaultProjectId: ProjectId.make("project:infra"),
    });
    const { workstreams } = yield* current;
    assert.deepStrictEqual(
      workstreams.map((workstream) => [workstream.id, workstream.defaultProjectId]),
      [
        [first, null],
        [second, ProjectId.make("project:infra")],
      ],
    );
    assert.isTrue(workstreams[0]!.orderKey < workstreams[1]!.orderKey);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("moves a session between workstreams, clearing its pin, and back to unsorted", () =>
  Effect.gen(function* () {
    const service = yield* WorkstreamService.WorkstreamService;
    const first = yield* create("Checkout rewrite");
    const second = yield* create("Flaky deploys");
    yield* service.mutate({ type: "thread.assign", threadId: THREAD, workstreamId: first });
    yield* service.mutate({ type: "thread.pin", threadId: THREAD, pinned: true, orderKey: "V" });
    assert.strictEqual((yield* current).memberships[0]?.pinOrderKey, "V");

    yield* service.mutate({ type: "thread.assign", threadId: THREAD, workstreamId: second });
    const moved = (yield* current).memberships;
    assert.deepStrictEqual(
      moved.map((membership) => [membership.workstreamId, membership.pinnedAt]),
      [[second, null]],
    );

    yield* service.mutate({ type: "thread.assign", threadId: THREAD, workstreamId: null });
    assert.deepStrictEqual((yield* current).memberships, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("deleting a workstream drops its memberships and memory but nothing else", () =>
  Effect.gen(function* () {
    const service = yield* WorkstreamService.WorkstreamService;
    const doomed = yield* create("Checkout rewrite");
    const kept = yield* create("Flaky deploys");
    yield* service.mutate({ type: "thread.assign", threadId: THREAD, workstreamId: doomed });
    yield* service.mutate({ type: "thread.assign", threadId: OTHER_THREAD, workstreamId: kept });
    yield* service.mutateMemory({
      type: "entry.add",
      workstreamId: doomed,
      kind: "fact",
      text: "Staging uses the eu-west cluster." as never,
    });
    yield* service.mutate({ type: "workstream.delete", workstreamId: doomed });
    const state = yield* current;
    assert.deepStrictEqual(
      state.workstreams.map((workstream) => workstream.id),
      [kept],
    );
    assert.deepStrictEqual(
      state.memberships.map((membership) => membership.threadId),
      [OTHER_THREAD],
    );
    assert.deepStrictEqual(yield* service.listEntries(doomed), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a session an agent starts joins its parent's workstream once", () =>
  Effect.gen(function* () {
    const service = yield* WorkstreamService.WorkstreamService;
    const parent = yield* create("Checkout rewrite");
    const other = yield* create("Flaky deploys");
    yield* service.mutate({ type: "thread.assign", threadId: THREAD, workstreamId: parent });
    yield* service.inheritWorkstream({ threadId: OTHER_THREAD, parentThreadId: THREAD });
    assert.strictEqual(
      Option.getOrThrow(yield* service.workstreamOfThread(OTHER_THREAD)).id,
      parent,
    );
    // The user's own placement wins over a later inherit.
    yield* service.mutate({ type: "thread.assign", threadId: OTHER_THREAD, workstreamId: other });
    yield* service.inheritWorkstream({ threadId: OTHER_THREAD, parentThreadId: THREAD });
    assert.strictEqual(
      Option.getOrThrow(yield* service.workstreamOfThread(OTHER_THREAD)).id,
      other,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("memory survives after the session that wrote it leaves, and edits bump entries", () =>
  Effect.gen(function* () {
    const service = yield* WorkstreamService.WorkstreamService;
    const workstreamId = yield* create("Checkout rewrite");
    yield* service.mutate({ type: "thread.assign", threadId: THREAD, workstreamId });
    const saved = yield* service.remember({
      workstreamId,
      threadId: THREAD,
      kind: "decision",
      text: "Keep v1 until March.",
    });
    yield* service.mutate({ type: "thread.assign", threadId: THREAD, workstreamId: null });
    yield* service.mutateMemory({ type: "entry.update", entryId: saved.id, locked: true });
    const entries = yield* service.listEntries(workstreamId);
    assert.deepStrictEqual(
      entries.map((entry) => [entry.text, entry.sourceThreadId, entry.locked]),
      [["Keep v1 until March.", THREAD, true]],
    );
    assert.isTrue(entries[0]!.revision > saved.revision);
    yield* service.mutateMemory({ type: "memory.clear", workstreamId });
    assert.deepStrictEqual(yield* service.listEntries(workstreamId), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("subscribers see changes live, and the gate key never leaves the server", () =>
  Effect.gen(function* () {
    const service = yield* WorkstreamService.WorkstreamService;
    const subscribed = yield* Deferred.make<void>();
    const keyed = yield* Deferred.make<WorkstreamState>();
    yield* service.subscribe().pipe(
      Stream.runForEach((state) =>
        state.memoryConfig.gateKeyConfigured
          ? Deferred.succeed(keyed, state)
          : Deferred.succeed(subscribed, undefined),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    yield* service.mutate({
      type: "memory-config.update",
      gateApiKey: "sk-test-value" as never,
      gateThreshold: 0.5,
    });
    const state = yield* Deferred.await(keyed);
    assert.strictEqual(state.memoryConfig.gateThreshold, 0.5);
    assert.notInclude(JSON.stringify(state), "sk-test-value");
    assert.deepStrictEqual((yield* service.gateSettings).apiKey, Option.some("sk-test-value"));
  }).pipe(Effect.provide(layerTest)),
);
