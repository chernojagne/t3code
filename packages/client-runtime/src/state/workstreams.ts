import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";

/**
 * Workstreams per environment: the live list with its memberships and server-wide memory
 * settings, one workstream's memory entries, and the two mutations. The server re-sends each
 * stream in full after every change, so no mutation refreshes anything.
 */
export function createWorkstreamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // Order keys and pins are computed from the last state seen, so edits to one environment
  // run in the order they were made.
  const serialPerEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:workstreams:state",
      tag: WS_METHODS.workstreamsSubscribe,
    }),
    memory: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:workstreams:memory",
      tag: WS_METHODS.workstreamsSubscribeMemory,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workstreams:mutate",
      tag: WS_METHODS.workstreamsMutate,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    mutateMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workstreams:mutate-memory",
      tag: WS_METHODS.workstreamsMutateMemory,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
