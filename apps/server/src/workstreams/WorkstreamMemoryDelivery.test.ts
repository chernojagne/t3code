import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { layerCountingRandom, OTHER_THREAD, THREAD } from "./testkit.ts";
import * as WorkstreamMemoryDelivery from "./WorkstreamMemoryDelivery.ts";
import * as WorkstreamService from "./WorkstreamService.ts";

const layerTest = WorkstreamMemoryDelivery.layer.pipe(
  Layer.provideMerge(WorkstreamService.layer),
  Layer.provide(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provide(layerCountingRandom),
  Layer.provideMerge(Layer.fresh(Sqlite.layerMemory)),
);

it.effect("a new session inherits the memory, then hears only what others add", () =>
  Effect.gen(function* () {
    const delivery = yield* WorkstreamMemoryDelivery.WorkstreamMemoryDelivery;
    const service = yield* WorkstreamService.WorkstreamService;
    const { workstreamId } = yield* service.mutate({
      type: "workstream.create",
      name: "Checkout rewrite" as never,
    });
    yield* service.mutate({
      type: "thread.assign",
      threadId: OTHER_THREAD,
      workstreamId: workstreamId!,
    });
    yield* service.remember({
      workstreamId: workstreamId!,
      threadId: OTHER_THREAD,
      kind: "decision",
      text: "Keep v1 until March.",
    });

    const turn = { threadId: THREAD, providerThreadId: "provider-thread:a", nativeThreadId: null };
    assert.strictEqual((yield* delivery.pending(turn)).text, "");

    yield* service.mutate({ type: "thread.assign", threadId: THREAD, workstreamId: workstreamId! });
    const first = yield* delivery.pending(turn);
    assert.include(first.text, "Keep v1 until March.");
    // Nothing is marked until the provider accepts the turn, so a refused turn is told again.
    assert.include((yield* delivery.pending(turn)).text, "Keep v1 until March.");
    yield* first.delivered;
    assert.strictEqual((yield* delivery.pending(turn)).text, "");

    yield* service.remember({
      workstreamId: workstreamId!,
      threadId: THREAD,
      kind: "fact",
      text: "My own note.",
    });
    assert.strictEqual((yield* delivery.pending(turn)).text, "");
    yield* service.remember({
      workstreamId: workstreamId!,
      threadId: OTHER_THREAD,
      kind: "open_item",
      text: "Port the refund flow.",
    });
    const delta = yield* delivery.pending(turn);
    assert.include(delta.text, "Port the refund flow.");
    assert.notInclude(delta.text, "Keep v1 until March.");

    // Moved between the read and the provider's answer: the old workstream's mark must not land.
    const other = yield* service.mutate({
      type: "workstream.create",
      name: "Flaky deploys" as never,
    });
    yield* service.remember({
      workstreamId: other.workstreamId!,
      threadId: OTHER_THREAD,
      kind: "fact",
      text: "Deploys flake on the arm runners.",
    });
    yield* service.mutate({
      type: "thread.assign",
      threadId: THREAD,
      workstreamId: other.workstreamId!,
    });
    yield* delta.delivered;
    assert.include((yield* delivery.pending(turn)).text, "Deploys flake on the arm runners.");
  }).pipe(Effect.provide(layerTest)),
);
