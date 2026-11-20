import {
  OrchestratorMcpFailure,
  WorkstreamMemoryEntryId,
  WorkstreamMemoryEntryKind,
  WORKSTREAM_MEMORY_ENTRY_MAX_CHARS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as WorkstreamService from "../../../workstreams/WorkstreamService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    WorkstreamService.WorkstreamService,
  ],
};

const WorkstreamMemoryReadTool = Tool.make("workstream_memory_read", {
  ...shared,
  description:
    "Read the shared memory of this thread's workstream: decisions, conventions, facts and open items recorded by every thread working on the same effort. `workstream` is null when this thread is in none.",
  success: Schema.Struct({
    workstream: Schema.NullOr(Schema.String),
    entries: Schema.Array(
      Schema.Struct({
        id: WorkstreamMemoryEntryId,
        kind: WorkstreamMemoryEntryKind,
        text: Schema.String,
      }),
    ),
  }),
})
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WorkstreamMemoryRememberTool = Tool.make("workstream_memory_remember", {
  ...shared,
  description:
    "Save one entry to this thread's workstream memory, for other threads on the same effort to read. Use for a decision and its reason, a convention the user asked for, a hard-won fact, or an open item; not for progress notes or secrets. T3 Code also records turns on its own, so save only what must not be missed.",
  parameters: Schema.Struct({
    kind: WorkstreamMemoryEntryKind,
    text: Schema.String.check(Schema.isMaxLength(WORKSTREAM_MEMORY_ENTRY_MAX_CHARS)).annotate({
      description: "One self-contained statement that makes sense without this conversation.",
    }),
  }),
  success: Schema.Struct({ id: WorkstreamMemoryEntryId }),
})
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients)
  .annotate(Tool.Destructive, false);

export const WorkstreamToolkit = Toolkit.make(
  WorkstreamMemoryReadTool,
  WorkstreamMemoryRememberTool,
);
