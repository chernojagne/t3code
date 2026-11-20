import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { selectMemoryDelivery } from "./WorkstreamMemory.ts";
import * as WorkstreamRepository from "./WorkstreamRepository.ts";

export interface PendingWorkstreamMemory {
  /** Context for the turn's prompt. Empty when the session has nothing new to read. */
  readonly text: string;
  /** Records that the provider accepted a turn carrying `text`. */
  readonly delivered: Effect.Effect<void>;
}

const NOTHING: PendingWorkstreamMemory = { text: "", delivered: Effect.void };

/** Hands each turn the workstream memory its session has not seen yet. */
export class WorkstreamMemoryDelivery extends Context.Service<
  WorkstreamMemoryDelivery,
  {
    /** Never fails: a turn must start even when memory cannot be read. */
    readonly pending: (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: string;
    }) => Effect.Effect<PendingWorkstreamMemory>;
  }
>()("t3/workstreams/WorkstreamMemoryDelivery") {}

const make = Effect.gen(function* () {
  const repository = yield* WorkstreamRepository.WorkstreamRepository;
  return WorkstreamMemoryDelivery.of({
    pending: Effect.fn("WorkstreamMemoryDelivery.pending")(
      function* (input) {
        const membership = yield* repository.getThread(input.threadId);
        if (Option.isNone(membership)) return NOTHING;
        const workstream = yield* repository.getWorkstream(membership.value.workstreamId);
        if (Option.isNone(workstream)) return NOTHING;
        const delivery = selectMemoryDelivery({
          workstream: workstream.value,
          membership: membership.value,
          entries: yield* repository.listEntries(workstream.value.id),
          providerThreadId: input.providerThreadId,
        });
        if (delivery.text === "") return NOTHING;
        return {
          text: delivery.text,
          delivered: repository
            .setThreadDelivery({
              threadId: input.threadId,
              providerThreadId: input.providerThreadId,
              revision: delivery.revision,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not record workstream memory delivery", { cause }),
              ),
            ),
        };
      },
      Effect.catch((cause) =>
        Effect.logWarning("Could not read workstream memory for a turn", { cause }).pipe(
          Effect.as(NOTHING),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(WorkstreamMemoryDelivery, make);
