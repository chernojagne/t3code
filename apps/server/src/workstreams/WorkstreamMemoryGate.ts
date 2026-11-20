import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GATE_QUESTION_NAME } from "./WorkstreamMemory.ts";

const DECISIONS_URL = "https://api.openai.com/v1/decisions";
const DECISIONS_MODEL = "gpt-6-luna";

export class WorkstreamMemoryGateError extends Schema.TaggedError<WorkstreamMemoryGateError>()(
  "WorkstreamMemoryGateError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const DecisionsReply = Schema.Struct({
  answers: Schema.Array(
    Schema.Struct({ name: Schema.String, probability: Schema.optional(Schema.Number) }),
  ),
});

/** Asks OpenAI's Decisions API how likely a turn is to hold something worth remembering. */
export class WorkstreamMemoryGate extends Context.Service<
  WorkstreamMemoryGate,
  {
    readonly probability: (input: {
      readonly apiKey: string;
      readonly digest: string;
      readonly instructions: string;
    }) => Effect.Effect<number, WorkstreamMemoryGateError>;
  }
>()("t3/workstreams/WorkstreamMemoryGate") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  return WorkstreamMemoryGate.of({
    probability: Effect.fn("WorkstreamMemoryGate.probability")(function* (input) {
      const request = HttpClientRequest.post(DECISIONS_URL).pipe(
        HttpClientRequest.bearerToken(input.apiKey),
        HttpClientRequest.bodyJsonUnsafe({
          model: DECISIONS_MODEL,
          input: input.digest,
          questions: [
            { type: "predicate", name: GATE_QUESTION_NAME, instructions: input.instructions },
          ],
        }),
      );
      const response = yield* http.execute(request).pipe(
        // A redirect could carry the key to another origin.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(
          (cause) =>
            new WorkstreamMemoryGateError({ detail: "Could not reach the Decisions API.", cause }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new WorkstreamMemoryGateError({
          detail: `The Decisions API answered with status ${response.status}.`,
        });
      }
      const reply = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(DecisionsReply)),
        Effect.mapError(
          (cause) =>
            new WorkstreamMemoryGateError({
              detail: "The Decisions API sent a reply T3 Code could not read.",
              cause,
            }),
        ),
      );
      const probability = reply.answers.find(
        (answer) => answer.name === GATE_QUESTION_NAME,
      )?.probability;
      if (probability === undefined) {
        return yield* new WorkstreamMemoryGateError({
          detail: "The Decisions API reply had no answer to the memory question.",
        });
      }
      return probability;
    }),
  });
});

export const layer = Layer.effect(WorkstreamMemoryGate, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
