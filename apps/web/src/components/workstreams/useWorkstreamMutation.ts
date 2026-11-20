import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  WorkstreamMutation,
  WorkstreamMutationResult,
  WorkstreamState,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";
import { useAtomCommand } from "../../state/use-atom-command";
import { workstreamEnvironment } from "../../state/workstreams";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  addOptimisticWorkstreamMutation,
  clearOptimisticWorkstreamMutations,
} from "./workstreamData";

export type RunWorkstreamMutation = (
  environmentId: EnvironmentId,
  mutation: WorkstreamMutation,
  /** The server state the edit was planned against; pass it to show the edit before the answer. */
  optimisticBase?: WorkstreamState | null,
) => Promise<WorkstreamMutationResult | null>;

/** Sends one workstream mutation and reports a failure as a toast. Null means it did not apply. */
export function useWorkstreamMutation(): RunWorkstreamMutation {
  const mutate = useAtomCommand(workstreamEnvironment.mutate, { reportFailure: false });
  return async (environmentId, mutation, optimisticBase) => {
    if (optimisticBase) addOptimisticWorkstreamMutation(environmentId, optimisticBase, mutation);
    const result = await mutate({ environmentId, input: mutation });
    if (result._tag === "Success") return result.value;
    clearOptimisticWorkstreamMutations(environmentId);
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Workstream not updated")),
          description:
            thrownErrorMessage(squashAtomCommandFailure(result), m) ?? m(msg("An error occurred.")),
        }),
      );
    }
    return null;
  };
}
