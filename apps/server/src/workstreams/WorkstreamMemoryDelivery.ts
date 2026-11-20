import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { memoryConversationKey, selectMemoryDelivery } from "./WorkstreamMemory.ts";
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
      /** The provider's own session id, once it has one. */
      readonly nativeThreadId: string | null;
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
        const conversation = memoryConversationKey(input);
        // The first turn was recorded before the provider named its session. Bind the mark to
        // that session now, so a replacement session is recognised as new.
        const recorded = membership.value.deliveredProviderThreadId;
        if (
          recorded !== null &&
          recorded !== conversation &&
          recorded.endsWith("|") &&
          conversation.startsWith(recorded)
        ) {
          yield* repository.setThreadDelivery({
            threadId: input.threadId,
            workstreamId: workstream.value.id,
            providerThreadId: conversation,
            revision: membership.value.deliveredRevision,
          });
        }
        const delivery = selectMemoryDelivery({
          workstream: workstream.value,
          membership: membership.value,
          entries: yield* repository.listEntries(workstream.value.id),
          conversation,
        });
        if (delivery.text === "") return NOTHING;
        return {
          text: delivery.text,
          delivered: repository
            .setThreadDelivery({
              threadId: input.threadId,
              workstreamId: workstream.value.id,
              providerThreadId: conversation,
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
