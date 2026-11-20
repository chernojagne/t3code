import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as WorkstreamService from "../../../workstreams/WorkstreamService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { WorkstreamToolkit } from "./tools.ts";

const callerWorkstream = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const workstreams = yield* WorkstreamService.WorkstreamService;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Workstream memory");
  const workstream = yield* workstreams
    .workstreamOfThread(thread.threadId)
    .pipe(Effect.mapError(unavailable));
  return { threadId: thread.threadId, workstream, workstreams };
});

export const layer = McpToolAccess.toLayer(WorkstreamToolkit, {
  workstream_memory_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { workstream, workstreams } = yield* callerWorkstream;
      if (Option.isNone(workstream)) return { workstream: null, entries: [] };
      const entries = yield* workstreams
        .listEntries(workstream.value.id)
        .pipe(Effect.mapError(unavailable));
      return {
        workstream: workstream.value.name,
        entries: entries.map(({ id, kind, text }) => ({ id, kind, text })),
      };
    }),
  ),
  workstream_memory_remember: McpToolAccess.actsAsCaller(({ kind, text }) =>
    Effect.gen(function* () {
      const { threadId, workstream, workstreams } = yield* callerWorkstream;
      const trimmed = text.trim();
      if (Option.isNone(workstream) || trimmed === "") {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: Option.isNone(workstream)
            ? "This thread is not in a workstream, so it has no shared memory."
            : "Give the entry some text.",
        });
      }
      const entry = yield* workstreams
        .remember({ workstreamId: workstream.value.id, threadId, kind, text: trimmed })
        .pipe(Effect.mapError(unavailable));
      return { id: entry.id };
    }),
  ),
});
