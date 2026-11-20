import { useAtomValue } from "@effect/atom-react";
import {
  applyWorkstreamMutation,
  type WorkstreamListEntry,
} from "@t3tools/client-runtime/state/workstream-list";
import type {
  EnvironmentId,
  Workstream,
  WorkstreamMutation,
  WorkstreamState,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { create } from "zustand";

import { environmentAtomList } from "../../state/environmentAtomList";
import { environmentServerConfigsAtom } from "../../state/server";
import { liveShellEnvironmentIdsAtom } from "../../state/shell";
import { workstreamEnvironment } from "../../state/workstreams";
import type { SidebarThreadSummary } from "../../types";

/** A workstream tagged with the environment that owns it. */
export type EnvironmentWorkstream = Workstream & { readonly environmentId: EnvironmentId };
export type WorkstreamEntry = WorkstreamListEntry<SidebarThreadSummary, EnvironmentWorkstream>;

/** Live environments whose server has workstreams, as one string so equal lists share a value. */
const workstreamEnvironmentsKeyAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  return [...get(liveShellEnvironmentIdsAtom)]
    .filter((id) => configs.get(id)?.environment.capabilities.workstreams === true)
    .toSorted()
    .join("\n");
}).pipe(Atom.withLabel("web-workstream-environments-key"));

const workstreamStatesAtom = environmentAtomList("web-workstream-states", (environmentId) =>
  workstreamEnvironment.state({ environmentId, input: {} }),
);

const NO_ENVIRONMENT_IDS: ReadonlyArray<EnvironmentId> = [];

export function useWorkstreamEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const key = useAtomValue(workstreamEnvironmentsKeyAtom);
  return key === "" ? NO_ENVIRONMENT_IDS : (key.split("\n") as EnvironmentId[]);
}

export function useWorkstreamsAvailable(): boolean {
  return useAtomValue(workstreamEnvironmentsKeyAtom) !== "";
}

interface OptimisticWorkstreamEdits {
  /** The server state the edits were made against; a newer one supersedes them. */
  readonly base: WorkstreamState;
  readonly mutations: ReadonlyArray<WorkstreamMutation>;
  readonly at: string;
}

const useOptimisticWorkstreamStore = create<{
  readonly byEnvironment: Readonly<Record<string, OptimisticWorkstreamEdits>>;
}>(() => ({ byEnvironment: {} }));

export function addOptimisticWorkstreamMutation(
  environmentId: EnvironmentId,
  base: WorkstreamState,
  mutation: WorkstreamMutation,
) {
  useOptimisticWorkstreamStore.setState((store) => {
    const current = store.byEnvironment[environmentId];
    return {
      byEnvironment: {
        ...store.byEnvironment,
        [environmentId]: {
          base,
          mutations: current?.base === base ? [...current.mutations, mutation] : [mutation],
          at: new Date().toISOString(),
        },
      },
    };
  });
}

export function clearOptimisticWorkstreamMutations(environmentId: EnvironmentId) {
  useOptimisticWorkstreamStore.setState((store) => {
    const { [environmentId]: _dropped, ...rest } = store.byEnvironment;
    return { byEnvironment: rest };
  });
}

export interface EnvironmentWorkstreamState {
  readonly environmentId: EnvironmentId;
  /** What the server last sent; mutations are planned and overlaid against this. */
  readonly serverState: WorkstreamState | null;
  /** The server state with this device's unanswered edits applied. */
  readonly state: WorkstreamState | null;
  readonly failed: boolean;
}

export function useWorkstreamStates(): ReadonlyArray<EnvironmentWorkstreamState> {
  const key = useAtomValue(workstreamEnvironmentsKeyAtom);
  const results = useAtomValue(workstreamStatesAtom(key));
  const optimistic = useOptimisticWorkstreamStore((store) => store.byEnvironment);
  const environmentIds = key === "" ? NO_ENVIRONMENT_IDS : (key.split("\n") as EnvironmentId[]);
  return environmentIds.map((environmentId, index) => {
    const result = results[index];
    const serverState = result ? AsyncResult.getOrElse(result, () => null) : null;
    const edits = optimistic[environmentId];
    return {
      environmentId,
      serverState,
      state:
        serverState !== null && edits?.base === serverState
          ? edits.mutations.reduce(
              (state, mutation) => applyWorkstreamMutation(state, mutation, edits.at),
              serverState,
            )
          : serverState,
      failed: result?._tag === "Failure",
    };
  });
}

export function workstreamKey(environmentId: EnvironmentId, workstreamId: string): string {
  return `${environmentId}:${workstreamId}`;
}

const workstreamPermissionsAtom = environmentAtomList(
  "web-workstream-permissions",
  workstreamEnvironment.mutate.permissionAtom,
);

/** Environments this session may change workstreams on. */
export function useWorkstreamEditableEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const key = useAtomValue(workstreamEnvironmentsKeyAtom);
  const permissions = useAtomValue(workstreamPermissionsAtom(key));
  const environmentIds = key === "" ? NO_ENVIRONMENT_IDS : (key.split("\n") as EnvironmentId[]);
  return new Set(environmentIds.filter((_, index) => permissions[index] === true));
}
